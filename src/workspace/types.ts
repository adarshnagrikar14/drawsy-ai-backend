export type WorkspaceProject = {
  id: string;
  title: string;
  version: number;
  createdAt: number;
  updatedAt: number;
  lastOpenedAt: number;
};

export type CanvasMetadata = {
  id: string;
  title: string;
  projectId: string | null;
  version: number;
  createdAt: number;
  updatedAt: number;
  lastOpenedAt: number;
  contentHash: string | null;
};

export type StoredCanvas = CanvasMetadata & {
  sceneObjectKey: string;
};

export type WorkspaceSnapshot = {
  projects: WorkspaceProject[];
  canvases: CanvasMetadata[];
};

export type PutProjectInput = Omit<WorkspaceProject, "version"> & {
  baseVersion: number;
};

export type PutCanvasInput = Omit<CanvasMetadata, "version" | "contentHash"> & {
  baseVersion: number;
  scene: unknown;
};

export type PatchCanvasInput = Pick<
  CanvasMetadata,
  "id" | "title" | "projectId" | "lastOpenedAt"
> & {
  baseVersion: number;
};

export interface WorkspaceService {
  getWorkspace(userId: string): Promise<WorkspaceSnapshot>;
  getCanvasScene(userId: string, canvasId: string): Promise<unknown>;
  putProject(userId: string, input: PutProjectInput): Promise<WorkspaceProject>;
  deleteProject(
    userId: string,
    projectId: string,
    baseVersion: number,
  ): Promise<{ deletedCanvasIds: string[] }>;
  putCanvas(userId: string, input: PutCanvasInput): Promise<CanvasMetadata>;
  patchCanvas(userId: string, input: PatchCanvasInput): Promise<CanvasMetadata>;
  deleteCanvas(
    userId: string,
    canvasId: string,
    baseVersion: number,
  ): Promise<void>;
}
