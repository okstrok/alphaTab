import { useAlphaTabApi, useAlphaTabEvent } from '@coderline/alphatab-react';
import clsx from 'clsx';
import { useEffect, useState } from 'react';
import styles from './alphajam.module.scss';
import type { EventResult } from './JamMatcher';

interface Mark {
    key: string;
    x: number;
    y: number;
    w: number;
    h: number;
    state: 'hit' | 'wrong' | 'missed';
}

/** Space around a note head the mark covers, in px. */
const PAD = 3;

function buildMarks(
    api: NonNullable<ReturnType<typeof useAlphaTabApi>>,
    results: ReadonlyMap<number, EventResult>
): Mark[] {
    const lookup = api.renderer?.boundsLookup;
    if (!lookup) {
        return [];
    }
    const marks: Mark[] = [];
    for (const result of results.values()) {
        const present = new Map(result.event.notes.map((n, i) => [n.midi, result.notes[i]]));
        for (const beat of result.event.beats) {
            for (const beatBounds of lookup.findBeats(beat) ?? []) {
                for (const noteBounds of beatBounds.notes ?? []) {
                    const midi = noteBounds.note.realValue;
                    if (!present.has(midi)) {
                        continue;
                    }
                    const state = result.outcome === 'missed' ? 'missed' : present.get(midi) ? 'hit' : 'wrong';
                    const b = noteBounds.noteHeadBounds;
                    marks.push({
                        key: `${result.event.index}:${noteBounds.note.id}:${b.x}:${b.y}`,
                        x: b.x - PAD,
                        y: b.y - PAD,
                        w: b.w + 2 * PAD,
                        h: b.h + 2 * PAD,
                        state
                    });
                }
            }
        }
    }
    return marks;
}

/**
 * Colors the judged notes of the song: green when played, red when wrong or missed. Placed in the
 * score overlay, so it moves with the notation in both the sheet and the sliding view.
 * `results` holds the latest result per beat.
 */
export function NoteMarks({ results }: { results: ReadonlyMap<number, EventResult> }) {
    const api = useAlphaTabApi();
    const [renderRevision, setRenderRevision] = useState(0);
    const [marks, setMarks] = useState<Mark[]>([]);
    useAlphaTabEvent(api, 'postRenderFinished', () => setRenderRevision(r => r + 1));

    useEffect(() => {
        setMarks(api ? buildMarks(api, results) : []);
    }, [api, results, renderRevision]);

    return (
        <div className={styles.marks} aria-hidden="true">
            {marks.map(m => (
                <div
                    key={m.key}
                    className={clsx(styles.mark, styles[`mark-${m.state}`])}
                    style={{ left: m.x, top: m.y, width: m.w, height: m.h }}
                />
            ))}
        </div>
    );
}
