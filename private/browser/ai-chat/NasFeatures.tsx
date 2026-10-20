/* SPDX-License-Identifier: MPL-2.0 */
import { useState } from 'react';
import { useReaderOriginalPages } from '@/features/reader/hooks/useReaderOriginalPages.ts';
import { useTranslationReader } from '@/features/translation/TranslationReader.tsx';
import {
    useChapterTranslationStatuses,
    ChapterTranslationBadge,
} from '@/features/translation/ChapterTranslationStatus.tsx';

export function ReaderFallback() {
    const [calls, setCalls] = useState(0);
    const translation = useTranslationReader(34);
    useReaderOriginalPages(34, translation.loading, !!translation.pages, () => setCalls((count) => count + 1));
    return (
        <>
            <p>Original-Aufrufe: {calls}</p>
            <p>
                {translation.loading
                    ? 'Übersetzung wird geprüft'
                    : translation.pages
                      ? 'Übersetzte Seiten'
                      : 'Original gewählt'}
            </p>
        </>
    );
}
export function ChapterBadges() {
    const { statuses, error } = useChapterTranslationStatuses(7);
    return (
        <>
            <p>{error}</p>
            {[34, 35, 36, 38].map((id) => (
                <section key={id} aria-label={`Kapitel ${id}`}>
                    Kapitel {id}
                    <ChapterTranslationBadge status={statuses.get(id)} />
                </section>
            ))}
        </>
    );
}
