"use client";

import {
  createContext,
  startTransition,
  useActionState,
  useContext,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import type { ActionResult } from "@/lib/action-result";
import { Alert } from "./alert";
import { Button } from "./button";
import { ConfirmDialog } from "./confirm-dialog";
import { useToast } from "./toast";

const Pending = createContext(false);

export type Confirmation = { message: string; confirmLabel: string };

// A form that sends to an action returning an ActionResult. A mistake shows next to the form and the typed values
// stay; success shows a toast. With `confirm`, it asks first. Its SubmitButton is disabled while the action runs.
export function ActionForm({
  action,
  confirm,
  className,
  children,
}: {
  action: (previous: ActionResult, formData: FormData) => Promise<ActionResult>;
  confirm?: Confirmation;
  className?: string;
  children: ReactNode;
}) {
  const showToast = useToast();
  const [state, formAction, pending] = useActionState(async (previous: ActionResult, formData: FormData) => {
    const result = await action(previous, formData);
    if (result?.ok) showToast(result.message);
    return result;
  }, null);
  const [asking, setAsking] = useState<FormData | null>(null);

  function send(formData: FormData) {
    startTransition(() => formAction(formData));
  }

  return (
    <form
      className={className}
      onSubmit={(event) => {
        // Sent from here rather than through the action prop, because React clears a form after its action prop runs.
        event.preventDefault();
        if (pending) return;
        const formData = new FormData(event.currentTarget);
        if (confirm) {
          setAsking(formData);
        } else {
          send(formData);
        }
      }}
    >
      <Pending value={pending}>{children}</Pending>
      {state?.ok === false ? <Alert tone="error">{state.error}</Alert> : null}
      {confirm ? (
        <ConfirmDialog
          open={asking !== null}
          message={confirm.message}
          confirmLabel={confirm.confirmLabel}
          onConfirm={() => {
            send(asking!);
            setAsking(null);
          }}
          onCancel={() => setAsking(null)}
        />
      ) : null}
    </form>
  );
}

// The submit button of an ActionForm: it shows `pendingLabel` and cannot be pressed again while the action runs.
export function SubmitButton({
  pendingLabel,
  disabled,
  children,
  ...props
}: Omit<ComponentProps<typeof Button>, "type"> & { pendingLabel: string }) {
  const pending = useContext(Pending);
  return (
    <Button {...props} type="submit" disabled={disabled || pending}>
      {pending ? pendingLabel : children}
    </Button>
  );
}
