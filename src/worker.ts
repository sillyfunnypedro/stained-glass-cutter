// Runs the image pipeline off the main thread so the UI stays responsive.
import { process, type Params } from "./processing";

export interface WorkerRequest {
  id: number;
  buffer: ArrayBuffer; // RGBA pixel data
  width: number;
  height: number;
  params: Params;
}

export interface WorkerResponse {
  id: number;
  buffer: ArrayBuffer; // RGBA result
  width: number;
  height: number;
}

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const { id, buffer, width, height, params } = e.data;
  const data = new Uint8ClampedArray(buffer);
  const result = process(data, width, height, params);
  const out = result.buffer as ArrayBuffer;
  const msg: WorkerResponse = { id, buffer: out, width, height };
  (self as unknown as Worker).postMessage(msg, [out]);
};
