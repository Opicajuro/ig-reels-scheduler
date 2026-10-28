import { ActionForm, SubmitButton } from "@/components/action-form";
import { cancelPostAction, retryPostAction } from "./actions";

// Cancel works until the post is published, including the 45 minutes before it while Instagram prepares the video.
export function CancelPostForm({ postId }: { postId: string }) {
  return (
    <ActionForm
      action={cancelPostAction}
      confirm={{ message: "Cancel this post? It will not be published.", confirmLabel: "Cancel post" }}
    >
      <input type="hidden" name="postId" value={postId} />
      <SubmitButton variant="danger" size="sm" pendingLabel="Canceling…">
        Cancel
      </SubmitButton>
    </ActionForm>
  );
}

export function RetryPostForm({ postId }: { postId: string }) {
  return (
    <ActionForm action={retryPostAction}>
      <input type="hidden" name="postId" value={postId} />
      <SubmitButton size="sm" pendingLabel="Retrying…">
        Retry
      </SubmitButton>
    </ActionForm>
  );
}
