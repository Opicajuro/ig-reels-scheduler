import { Card } from "@/components/card";
import { getAppearance } from "@/lib/appearance";
import { prisma } from "@/lib/prisma";
import { AppearanceForm } from "./appearance-form";
import styles from "./appearance.module.css";

// The design the whole app wears, its colours and a colour shift.
export async function AppearanceSection() {
  const appearance = await getAppearance(prisma);

  return (
    <>
      <h2 id="appearance">Appearance</h2>
      <div className={styles.section}>
        <Card>
          <AppearanceForm saved={appearance} />
        </Card>
      </div>
    </>
  );
}
