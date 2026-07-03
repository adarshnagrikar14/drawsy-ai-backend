export type CommentMessage = {
  id: string;
  body: string;
  createdAt: number;
  updatedAt: number;
};

export type CanvasComment = {
  id: string;
  canvasId: string;
  x: number;
  y: number;
  elementId: string | null;
  status: "open" | "resolved";
  version: number;
  createdAt: number;
  updatedAt: number;
  messages: CommentMessage[];
};

export type CreateCommentInput = Pick<
  CanvasComment,
  "id" | "canvasId" | "x" | "y" | "elementId"
> & {
  messageId: string;
  body: string;
};

export interface CommentService {
  list(userId: string, canvasId: string): Promise<CanvasComment[]>;
  create(userId: string, input: CreateCommentInput): Promise<CanvasComment>;
  delete(
    userId: string,
    canvasId: string,
    commentId: string,
    baseVersion: number,
  ): Promise<void>;
  deleteAllForCanvas(userId: string, canvasId: string): Promise<void>;
}
