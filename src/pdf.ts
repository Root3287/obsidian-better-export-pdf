import * as fs from "fs/promises";
import electron, { WebviewTag } from "electron";
import { PDFDocument, PDFName, PDFDict, PDFArray, PDFRef, PDFHexString, StandardFonts } from "pdf-lib";
import { FrontMatterCache, TFile } from "obsidian";

import { TreeNode, getHeadingTree } from "./utils";
import { TConfig } from "./modal";
import { BetterExportPdfPluginSettings } from "./main";

interface TPosition {
  [key: string]: number[];
}

// heading, block position
export async function getDestPosition(pdfDoc: PDFDocument): Promise<TPosition> {
  const pages = pdfDoc.getPages();
  const links: TPosition = {};

  pages.forEach((page, pageIndex) => {
    const annotations = page.node.Annots();
    if (!annotations) {
      return;
    }
    const numAnnotations = annotations?.size() ?? 0;

    for (let annotIndex = 0; annotIndex < numAnnotations; annotIndex++) {
      try {
        const annotation = annotations.lookup(annotIndex, PDFDict);
        const subtype = annotation.get(PDFName.of("Subtype"));
        if (subtype?.toString() === "/Link") {
          const linkDict = annotation.get(PDFName.of("A")) as PDFDict;
          // @ts-ignore
          const uri = linkDict?.get(PDFName.of("URI")).toString();
          console.debug("uri", uri);
          const regexMatch = /^\(af:\/\/(.+)\)$/.exec(uri || "");

          if (regexMatch) {
            const rect = (annotation.get(PDFName.of("Rect")) as PDFArray)?.asRectangle();
            const linkUrl = regexMatch[1];
            const yPos = rect.y;
            links[linkUrl] = [pageIndex, yPos];
          }
        }
      } catch (err) {
        console.error(err);
      }
    }
  });

  return links;
}

// refer to: https://github.com/Hopding/pdf-lib/issues/206
export async function setAnchors(pdfDoc: PDFDocument, links: TPosition) {
  const pages = pdfDoc.getPages();

  pages.forEach((page, _) => {
    const annots = page.node.Annots();
    if (!annots) {
      return;
    }
    const numAnnotations = annots?.size() ?? 0;

    for (let idx = 0; idx < numAnnotations; idx++) {
      try {
        const linkAnnotRef = annots.get(idx);
        const linkAnnot = annots.lookup(idx, PDFDict);
        const subtype = linkAnnot.get(PDFName.of("Subtype"));
        if (subtype?.toString() === "/Link") {
          const linkDict = linkAnnot.get(PDFName.of("A")) as PDFDict;
          // @ts-ignore
          const uri = linkDict?.get(PDFName.of("URI")).toString();
          console.debug("uri", uri);
          const regexMatch = /^\(an:\/\/(.+)\)$/.exec(uri || "");

          const key = regexMatch?.[1];
          if (key && links?.[key]) {
            const [pageIdx, yPos] = links[key];
            const newAnnot = pdfDoc.context.obj({
              Type: "Annot",
              Subtype: "Link",
              Rect: linkAnnot.lookup(PDFName.of("Rect")),
              Border: linkAnnot.lookup(PDFName.of("Border")),
              C: linkAnnot.lookup(PDFName.of("C")),
              Dest: [pages[pageIdx].ref, "XYZ", null, yPos, null],
            });

            // @ts-ignore
            // Replace all occurrences of the external annotation with the internal one
            pdfDoc.context.assign(linkAnnotRef, newAnnot);
          }
        }
      } catch (err) {
        console.error(err);
      }
    }
  });

  return links;
}

export function generateOutlines(root: TreeNode, positions: TPosition, maxLevel = 6) {
  const _outline = (node: TreeNode) => {
    if (node.level > maxLevel) {
      return;
    }
    const [pageIdx, pos] = positions?.[node.key] ?? [0, 0];
    const outline: PDFOutline = {
      title: node.title,
      to: [pageIdx, 0, pos],
      open: false,
      children: [],
    };
    if (node.children?.length > 0) {
      for (const item of node.children) {
        const child = _outline(item);
        if (child) {
          outline.children.push(child);
        }
      }
    }
    return outline;
  };

  return _outline(root)?.children ?? [];
}

// From: https://github.com/marp-team/marp-cli/blob/d0cee502f2785e1a2f998f3afc831849e3f6efc9/src/utils/pdf.ts
// --- Outline ---
type PDFOutlineTo =
  // | string
  number | [pageIndex: number, xPercentage: number, yPercentage: number];

export interface PDFOutlineItem {
  title: string;
  to: PDFOutlineTo;
  italic?: boolean;
  bold?: boolean;
}

export interface PDFOutlineItemWithChildren extends Omit<PDFOutlineItem, "to"> {
  to?: PDFOutlineTo;
  children: PDFOutline[];
  open: boolean;
}

export type PDFOutline = PDFOutlineItem | PDFOutlineItemWithChildren;

const walk = (
  outlines: readonly PDFOutline[],
  callback: (outline: PDFOutline) => void | boolean, // stop walking to children if returned false
) => {
  for (const outline of outlines) {
    const ret = callback(outline);
    if ("children" in outline && ret !== false) walk(outline.children, callback);
  }
};

const flatten = (outlines: readonly PDFOutline[]) => {
  const result: PDFOutline[] = [];

  walk(outlines, (outline) => void result.push(outline));
  return result;
};

const getOpeningCount = (outlines: readonly PDFOutline[]) => {
  let count = 0;

  walk(outlines, (outline) => {
    count += 1;
    return !("open" in outline && !outline.open);
  });

  return count;
};

export const setOutline = async (doc: PDFDocument, outlines: readonly PDFOutline[]) => {
  // Refs
  const rootRef = doc.context.nextRef();
  const refMap = new WeakMap<PDFOutline, PDFRef>();

  for (const outline of flatten(outlines)) {
    refMap.set(outline, doc.context.nextRef());
  }

  const pageRefs = (() => {
    const refs: PDFRef[] = [];

    doc.catalog.Pages().traverse((kid, ref) => {
      if (kid.get(kid.context.obj("Type"))?.toString() === "/Page") {
        refs.push(ref);
      }
    });

    return refs;
  })();

  // Outlines
  const createOutline = (outlines: readonly PDFOutline[], parent: PDFRef) => {
    const { length } = outlines;

    for (let i = 0; i < length; i += 1) {
      const outline = outlines[i];
      const outlineRef = refMap.get(outline)!;

      const destOrAction = (() => {
        // if (typeof outline.to === 'string') {
        //   // URL
        //   return { A: { S: 'URI', URI: PDFHexString.fromText(outline.to) } }
        // } else
        if (typeof outline.to === "number") {
          return { Dest: [pageRefs[outline.to], "Fit"] };
        } else if (Array.isArray(outline.to)) {
          // const page = doc.getPage(outline.to[0]);
          // const width = page.getWidth() * outline.to[1];
          // const height = page.getHeight()* outline.to[2];

          return {
            Dest: [pageRefs[outline.to[0]], "XYZ", outline.to[1], outline.to[2], null],
          };
        }
        return {};
      })();

      const childrenDict = (() => {
        if ("children" in outline && outline.children.length > 0) {
          createOutline(outline.children, outlineRef);

          return {
            First: refMap.get(outline.children[0])!,
            Last: refMap.get(outline.children[outline.children.length - 1])!,
            Count: getOpeningCount(outline.children) * (outline.open ? 1 : -1),
          };
        }
        return {};
      })();

      doc.context.assign(
        outlineRef,
        doc.context.obj({
          Title: PDFHexString.fromText(outline.title),
          Parent: parent,
          ...(i > 0 ? { Prev: refMap.get(outlines[i - 1])! } : {}),
          ...(i < length - 1 ? { Next: refMap.get(outlines[i + 1])! } : {}),
          ...childrenDict,
          ...destOrAction,
          F: (outline.italic ? 1 : 0) | (outline.bold ? 2 : 0),
        }),
      );
    }
  };

  createOutline(outlines, rootRef);

  // Root
  const rootCount = getOpeningCount(outlines);

  doc.context.assign(
    rootRef,
    doc.context.obj({
      Type: "Outlines",
      ...(rootCount > 0
        ? {
            First: refMap.get(outlines[0])!,
            Last: refMap.get(outlines[outlines.length - 1])!,
          }
        : {}),
      Count: rootCount,
    }),
  );

  doc.catalog.set(doc.context.obj("Outlines"), rootRef);
};

type PageSetting = {
  format: string;
  position: number;
};

export async function addPageNumbers(doc: PDFDocument, setting: PageSetting) {
  const courierBoldFont = await doc.embedFont(StandardFonts.TimesRoman);
  const pageIndices = doc.getPageIndices();

  const total = pageIndices.length;

  for (const pageIndex of pageIndices) {
    const page = doc.getPage(pageIndex);

    const content = setting.format.replace("{page}", `${pageIndex + 1}`).replace("{pages}", `${total}`);
    page.drawText(content, {
      x: page.getWidth() / 2,
      y: setting.position,
      font: courierBoldFont,
      size: 12,
    });
  }
}

export type EditPDFParamType = {
  headings: TreeNode;
  maxLevel: number;
  frontMatter?: FrontMatterCache;
};

// add outlines
export async function editPDF(
  data: Uint8Array,
  { headings, maxLevel, frontMatter }: EditPDFParamType,
): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.load(data);
  const posistions = await getDestPosition(pdfDoc);

  setAnchors(pdfDoc, posistions);

  const outlines = generateOutlines(headings, posistions, maxLevel);

  setOutline(pdfDoc, outlines);
  if (frontMatter) {
    setMetadata(pdfDoc, frontMatter);
  }
  data = await pdfDoc.save();
  return data;
}

// add pdf metadata [title, author, keywords, created_at, updated_at, creator, producer]
export function setMetadata(
  pdfDoc: PDFDocument,
  { title, author, keywords, subject, creator, created_at, updated_at }: FrontMatterCache,
) {
  if (title) {
    pdfDoc.setTitle(title, { showInWindowTitleBar: true });
  }
  if (author) {
    pdfDoc.setAuthor(author);
  }
  if (keywords) {
    pdfDoc.setKeywords(typeof keywords == "string" ? [keywords] : keywords);
  }
  if (subject) {
    pdfDoc.setSubject(subject);
  }
  pdfDoc.setCreator(creator ?? "Obsidian");
  pdfDoc.setProducer("Obsidian");
  pdfDoc.setCreationDate(new Date(created_at ?? new Date()));
  pdfDoc.setModificationDate(new Date(updated_at ?? new Date()));
}

export async function exportToPDF(
  outputFile: string,
  config: TConfig & BetterExportPdfPluginSettings,
  webview: WebviewTag,
  doc: Document,
  frontMatter?: FrontMatterCache,
) {
  const printOptions: electron.PrintToPDFOptions = {
    pageSize: config["pageSise"],
    ...config,
    scale: config["scale"] / 100,
    margins: {
      marginType: "default",
    },
    displayHeaderFooter: true,
    headerTemplate: config["displayHeader"] ? config["headerTemplate"] : "<span></span>",
    footerTemplate: config["displayFooter"] ? config["footerTemplate"] : "<span></span>",
  };

  if (config.marginType == "3") {
    // Custom Margin
    printOptions["margins"] = {
      marginType: "custom",
      top: parseFloat(config["marginTop"] ?? "0") / 25.4,
      bottom: parseFloat(config["marginBottom"] ?? "0") / 25.4,
      left: parseFloat(config["marginLeft"] ?? "0") / 25.4,
      right: parseFloat(config["marginRight"] ?? "0") / 25.4,
    };
  }

  const w = document.querySelector("webview:last-child") as WebviewTag;

  try {
    let data = await w.printToPDF(printOptions);

    data = await editPDF(data, {
      headings: getHeadingTree(doc),
      frontMatter,
      maxLevel: parseInt(config?.maxLevel ?? "6"),
    });

    await fs.writeFile(outputFile, data);

    if (config.open) {
      // @ts-ignore
      electron.remote.shell.openPath(outputFile);
    }
  } catch (error) {
    console.error(error);
  }
}

export async function getOutputFile(file: TFile) {
  // @ts-ignore
  const result = await electron.remote.dialog.showSaveDialog({
    title: "Export to PDF",
    defaultPath: file.basename + ".pdf",
    filters: [
      { name: "All Files", extensions: ["*"] },
      { name: "PDF", extensions: ["pdf"] },
    ],
    properties: ["showOverwriteConfirmation", "createDirectory"],
  });

  if (result.canceled) {
    return;
  }
  return result.filePath;
}
