export class TFile { constructor(public path: string, public stat: { mtime: number; size: number }) {} }
export const moment = () => ({ format: () => "2026-10-18 1742" });
export const Platform = { isDesktopApp: false, isMobile: false };
export const requestUrl = () => { throw new Error("network not available in tests"); };
