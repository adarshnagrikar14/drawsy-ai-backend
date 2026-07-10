export type PresentationMetadata = {
  id: string;
  title: string;
  version: number;
  createdAt: number;
  updatedAt: number;
  lastOpenedAt: number;
  contentHash: string | null;
};

export type StoredPresentation = PresentationMetadata & {
  sceneObjectKey: string;
};

export type PresentationSnapshot = {
  presentations: PresentationMetadata[];
};

export type PutPresentationInput = Omit<
  PresentationMetadata,
  "version" | "contentHash"
> & {
  baseVersion: number;
  scene: unknown;
};

export type PatchPresentationInput = Pick<
  PresentationMetadata,
  "id" | "title" | "lastOpenedAt"
> & {
  baseVersion: number;
};

export interface PresentationService {
  getPresentations(userId: string): Promise<PresentationSnapshot>;
  getPresentationScene(
    userId: string,
    presentationId: string,
  ): Promise<unknown>;
  putPresentation(
    userId: string,
    input: PutPresentationInput,
  ): Promise<PresentationMetadata>;
  patchPresentation(
    userId: string,
    input: PatchPresentationInput,
  ): Promise<PresentationMetadata>;
  deletePresentation(
    userId: string,
    presentationId: string,
    baseVersion: number,
  ): Promise<void>;
}
