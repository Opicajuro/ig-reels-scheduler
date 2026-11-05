import { ActionForm, SubmitButton } from "@/components/action-form";
import {
  cancelFacebookPostAction,
  cancelPostAction,
  cancelTikTokPostAction,
  cancelYouTubePostAction,
  retryFacebookPostAction,
  retryPostAction,
  retryTikTokPostAction,
  retryYouTubePostAction,
} from "./actions";

export type PostPlatform = "instagram" | "youtube" | "facebook" | "tiktok";

const CANCEL = {
  instagram: cancelPostAction,
  youtube: cancelYouTubePostAction,
  facebook: cancelFacebookPostAction,
  tiktok: cancelTikTokPostAction,
};
const RETRY = {
  instagram: retryPostAction,
  youtube: retryYouTubePostAction,
  facebook: retryFacebookPostAction,
  tiktok: retryTikTokPostAction,
};

// Cancel works until the post is published, including the 45 minutes before it while Instagram prepares the video. A
// YouTube, Facebook or TikTok post can be canceled until its upload starts.
export function CancelPostForm({ postId, platform = "instagram" }: { postId: string; platform?: PostPlatform }) {
  return (
    <ActionForm
      action={CANCEL[platform]}
      confirm={{ message: "Cancel this post? It will not be published.", confirmLabel: "Cancel post" }}
    >
      <input type="hidden" name="postId" value={postId} />
      <SubmitButton variant="danger" size="sm" pendingLabel="Canceling…">
        Cancel
      </SubmitButton>
    </ActionForm>
  );
}

export function RetryPostForm({ postId, platform = "instagram" }: { postId: string; platform?: PostPlatform }) {
  return (
    <ActionForm action={RETRY[platform]}>
      <input type="hidden" name="postId" value={postId} />
      <SubmitButton size="sm" pendingLabel="Retrying…">
        Retry
      </SubmitButton>
    </ActionForm>
  );
}
