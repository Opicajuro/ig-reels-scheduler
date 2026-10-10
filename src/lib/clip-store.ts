import { deleteObject, copyObject, downloadToFile, uploadFromFile } from "./storage";

// Where clip files live. The render job and the project manager both use it, so tests can swap in a local folder.
export type ClipStore = {
  downloadTo(key: string, filePath: string): Promise<void>;
  upload(key: string, filePath: string, contentType: string): Promise<void>;
  copy(from: string, to: string): Promise<void>;
  remove(key: string): Promise<void>;
};

export const s3ClipStore: ClipStore = {
  downloadTo: downloadToFile,
  upload: uploadFromFile,
  copy: copyObject,
  remove: deleteObject,
};
