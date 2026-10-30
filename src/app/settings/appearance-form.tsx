"use client";

import { useEffect, useState, type CSSProperties } from "react";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { DESIGNS, PALETTES, type Appearance, type Design, type Palette } from "@/lib/appearance";
import { saveAppearanceAction } from "./appearance-actions";
import styles from "./appearance.module.css";

// Quick colour shifts, in degrees.
const HUES = [0, 40, 110, 160, 220, 300];

// Puts a look on the page: the same attributes the root layout sets from the saved appearance.
function wear({ design, palette, hue }: Appearance) {
  const root = document.documentElement;
  root.dataset.design = design;
  root.dataset.palette = palette;
  root.style.setProperty("--hue", String(hue));
}

// The page wears what is picked here, or the design under the pointer, before it is saved. Leaving the page without
// saving puts the saved look back.
export function AppearanceForm({ saved }: { saved: Appearance }) {
  const [design, setDesign] = useState<Design>(saved.design);
  const [palette, setPalette] = useState<Palette>(saved.palette);
  const [hue, setHue] = useState(saved.hue);
  const [hovered, setHovered] = useState<Design | null>(null);

  useEffect(() => {
    wear({ design: hovered ?? design, palette, hue });
    return () => wear(saved);
  }, [hovered, design, palette, hue, saved]);

  return (
    <ActionForm action={saveAppearanceAction} className={styles.form}>
      <fieldset className={styles.group}>
        <legend>Design</legend>
        <div className={styles.designs}>
          {(Object.keys(DESIGNS) as Design[]).map((key) => (
            <label
              key={key}
              className={styles.design}
              onMouseEnter={() => setHovered(key)}
              onMouseLeave={() => setHovered(null)}
            >
              <input type="radio" name="design" value={key} checked={design === key} onChange={() => setDesign(key)} />
              <span className={styles.preview} data-design={key} data-palette={palette} aria-hidden="true">
                <span className={styles.previewBar}>
                  <span className={styles.previewMark} />
                </span>
                <span className={styles.previewBody}>
                  <span className={styles.previewTitle}>Aa</span>
                  <span className={styles.previewButtons}>
                    <span className={styles.previewPrimary} />
                    <span className={styles.previewSecondary} />
                  </span>
                  <span className={styles.previewCard} />
                </span>
              </span>
              <strong>{DESIGNS[key].name}</strong>
              <small>{DESIGNS[key].description}</small>
            </label>
          ))}
        </div>
      </fieldset>

      {/* Only Night Spring has palettes; the choice is kept while another design is picked. */}
      <fieldset className={styles.group} hidden={design !== "night"}>
        <legend>Colours</legend>
        <div className={styles.chips}>
          {(Object.keys(PALETTES) as Palette[]).map((key) => (
            <label key={key} className={styles.chip}>
              <input type="radio" name="palette" value={key} checked={palette === key} onChange={() => setPalette(key)} />
              <i style={{ background: `conic-gradient(${PALETTES[key].colors[0]} 0 50%, ${PALETTES[key].colors[1]} 0)` }} />
              {PALETTES[key].name}
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className={styles.group}>
        <legend>Colour shift</legend>
        <div className={styles.hues}>
          <input
            type="range"
            name="hue"
            min={0}
            max={359}
            value={hue}
            onChange={(event) => setHue(Number(event.target.value))}
            aria-label="Colour shift in degrees"
            aria-describedby="hue-value"
          />
          <span id="hue-value" className={styles.hueValue}>
            {hue === 0 ? "Original colours" : `Shifted ${hue}°`}
          </span>
          <span className={styles.hueSwatches}>
            {HUES.map((value) => (
              <button
                key={value}
                type="button"
                className={styles.hueSwatch}
                style={{ "--swatch-hue": value } as CSSProperties}
                aria-pressed={hue === value}
                title={value === 0 ? "Original colours" : `Shift ${value}°`}
                onClick={() => setHue(value)}
              />
            ))}
          </span>
        </div>
        <p className={styles.note}>Turns the design&apos;s colours around the colour wheel. Videos keep their own colours.</p>
      </fieldset>

      <div>
        <SubmitButton variant="primary" pendingLabel="Saving…">
          Save design
        </SubmitButton>
      </div>
    </ActionForm>
  );
}
