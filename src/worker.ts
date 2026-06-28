// Runs the image pipeline off the main thread so the UI stays responsive.
import { process, computeMasks, type Params } from "./processing";
import { buildFilledSvg, buildStrokedSvg } from "./svg";

export type SvgVariant = "cells" | "lines-outline" | "lines-centerline";

interface BaseRequest {
  id: number;
  buffer: ArrayBuffer; // RGBA pixel data
  width: number;
  height: number;
  params: Params;
}
export interface PngRequest extends BaseRequest {
  kind: "png";
}
export interface SvgRequest extends BaseRequest {
  kind: "svg";
  variant: SvgVariant;
}
export type WorkerRequest = PngRequest | SvgRequest;

export interface PngResponse {
  kind: "png";
  id: number;
  buffer: ArrayBuffer; // RGBA result
  width: number;
  height: number;
}
export interface SvgResponse {
  kind: "svg";
  id: number;
  svg: string;
}
export type WorkerResponse = PngResponse | SvgResponse;

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const req = e.data;
  const data = new Uint8ClampedArray(req.buffer);

  if (req.kind === "svg") {
    const m = computeMasks(data, req.width, req.height, req.params);
    let svg: string;
    if (req.variant === "cells") {
      svg = buildFilledSvg(m.interior, m.w, m.h, req.params.smoothSigma);
    } else if (req.variant === "lines-outline") {
      svg = buildFilledSvg(m.lineCore, m.w, m.h, req.params.smoothSigma);
    } else {
      svg = buildStrokedSvg(m.skeleton, m.w, m.h, Math.max(req.params.lineWidth, 1));
    }
    const res: SvgResponse = { kind: "svg", id: req.id, svg };
    (self as unknown as Worker).postMessage(res);
    return;
  }

  const result = process(data, req.width, req.height, req.params);
  const out = result.buffer as ArrayBuffer;
  const res: PngResponse = {
    kind: "png",
    id: req.id,
    buffer: out,
    width: req.width,
    height: req.height,
  };
  (self as unknown as Worker).postMessage(res, [out]);
};
