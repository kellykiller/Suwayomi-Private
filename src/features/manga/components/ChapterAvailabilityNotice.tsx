/*
 * Copyright (C) Contributors to the Suwayomi project
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';

export function ChapterAvailabilityNotice({
    checking,
    failed,
    retry,
}: {
    checking: boolean;
    failed: number;
    retry: () => void;
}) {
    return (
        <>
            {checking && (
                <Alert severity="info">Verfügbare Kapitel werden geprüft. Leere Manga werden ausgeblendet.</Alert>
            )}
            {!!failed && (
                <Alert
                    severity="warning"
                    action={
                        <Button color="inherit" onClick={retry}>
                            Erneut prüfen
                        </Button>
                    }
                >
                    Bei {failed} Titeln konnten die Kapitel nicht geprüft werden. Diese Treffer werden vorerst nicht
                    angezeigt.
                </Alert>
            )}
        </>
    );
}
