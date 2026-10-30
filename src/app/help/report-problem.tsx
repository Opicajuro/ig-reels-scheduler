import { ActionForm, SubmitButton } from "@/components/action-form";
import { reportProblemAction } from "./report-actions";

// "Report a problem" on the Help and Settings pages.
export function ReportProblemButton() {
  return (
    <ActionForm action={reportProblemAction}>
      <SubmitButton pendingLabel="Making the report…">Report a problem</SubmitButton>
    </ActionForm>
  );
}
