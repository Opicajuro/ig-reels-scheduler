import { ActionForm, SubmitButton } from "@/components/action-form";
import { cancelPostAction, cancelYouTubePostAction, retryPostAction, retryYouTubePostAction } from "./actions";

// Cancel works until the post is published, including the 45 minutes before it while Instagram prepares the video. A
// YouTube post can be canceled until its upload starts.
export function CancelPostForm({ postId, youtube = false }: { postId: string; youtube?: boolean }) {
  return (
    <ActionForm
      action={youtube ? cancelYouTubePostAction : cancelPostAction}
      confirm={{ message: "Cancel this post? It will not be published.", confirmLabel: "Cancel post" }}
    >
      <input type="hidden" name="postId" value={postId} />
      <SubmitButton variant="danger" size="sm" pendingLabel="Canceling…">
        Cancel
      </SubmitButton>
    </ActionForm>
  );
}

export function RetryPostForm({ postId, youtube = false }: { postId: string; youtube?: boolean }) {
  return (
    <ActionForm action={youtube ? retryYouTubePostAction : retryPostAction}>
      <input type="hidden" name="postId" value={postId} />
      <SubmitButton size="sm" pendingLabel="Retrying…">
        Retry
      </SubmitButton>
    </ActionForm>
  );
}
