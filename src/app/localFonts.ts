import { singleFace } from '../geom/sfnt';

/**
 * Monotype faces that most computers already have. They cannot be served
 * from here, so they are read from the visitor's own installed copy through
 * the Local Font Access API, which only Chromium browsers implement.
 */
export const LOCAL_FONTS = [
  { label: 'Savoye LET', postscript: 'SavoyeLetPlain', note: 'engraved, long swashes' },
  { label: 'Brush Script', postscript: 'BrushScriptMT', note: 'the classic' },
] as const;

export type LocalFont = (typeof LOCAL_FONTS)[number];

interface FontData {
  postscriptName: string;
  blob(): Promise<Blob>;
}

type QueryLocalFonts = (options?: { postscriptNames?: string[] }) => Promise<FontData[]>;

/**
 * The installed font's bytes, reduced to the one face asked for. macOS keeps
 * Savoye LET in a collection and the browser hands back the whole file.
 * Must be called from a user gesture: the first call raises the permission
 * prompt.
 */
export const readLocalFont = async (font: LocalFont): Promise<ArrayBuffer> => {
  const query = (window as Window & { queryLocalFonts?: QueryLocalFonts }).queryLocalFonts;
  if (!query) {
    throw new Error(`${font.label} is read from your computer, which needs Chrome or Edge. Or load the font file below.`);
  }
  const blocked = new Error(`Allow access to fonts to use ${font.label}: click the icon at the left of the address bar.`);
  let found: FontData[];
  try {
    found = await query({ postscriptNames: [font.postscript] });
  } catch {
    throw blocked;
  }
  const face = found.find((f) => f.postscriptName === font.postscript);
  if (!face) {
    // Some Chromium versions answer a refusal with an empty list rather than an error.
    const state = await navigator.permissions
      .query({ name: 'local-fonts' as PermissionName })
      .then((p) => p.state, () => 'prompt');
    throw state === 'denied' ? blocked : new Error(`${font.label} is not installed on this computer.`);
  }
  return singleFace(await (await face.blob()).arrayBuffer(), font.postscript);
};
