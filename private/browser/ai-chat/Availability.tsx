/* SPDX-License-Identifier: MPL-2.0 */
import { useState } from 'react';
import { useReadableMangas } from '@/features/manga/hooks/useReadableMangas.ts';
import { ChapterAvailabilityNotice } from '@/features/manga/components/ChapterAvailabilityNotice.tsx';

const first = [
    { id: 100, sourceId: '1', title: 'Leer' },
    { id: 101, sourceId: '1', title: 'Lesbar' },
    { id: 102, sourceId: '2', title: 'Fehler' },
];
const second = [{ id: 103, sourceId: '1', title: 'Andere Suche' }];
export function Availability() {
    const [changed, setChanged] = useState(false);
    const status = useReadableMangas(changed ? second : first, String(changed));
    return (
        <>
            <ChapterAvailabilityNotice {...status} />
            <button onClick={() => setChanged((value) => !value)}>Suche wechseln</button>
            <ul aria-label="Verfügbare Manga">
                {status.mangas.map((manga) => (
                    <li key={manga.id}>{manga.title}</li>
                ))}
            </ul>
            <p>{status.checking ? 'Prüfung läuft' : 'Prüfung abgeschlossen'}</p>
        </>
    );
}
