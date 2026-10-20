/* SPDX-License-Identifier: MPL-2.0 */
import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react-swc';
const root = import.meta.dirname;
export default defineConfig({
    root,
    plugins: [react({ plugins: [['@lingui/swc-plugin', {}]] })],
    resolve: {
        alias: [
            ...[
                'lib/requests/RequestManager.ts',
                'features/source/services/Sources.ts',
                'features/settings/services/ServerSettingsMetadata.ts',
                'features/navigation-bar/hooks/useAppTitleAndAction.ts',
                'features/navigation-bar/hooks/useAppTitle.ts',
                'features/source/components/SourceLanguageSelect.tsx',
                'base/components/SpinnerImage.tsx',
                'base/AppRoute.constants.ts',
                'features/manga/services/Mangas.ts',
            ].map((value) => ({ find: '@/' + value, replacement: path.resolve(root, 'mocks.tsx') })),
            { find: '@', replacement: path.resolve(root, '../../../src') },
        ],
    },
    build: { outDir: '/tmp/suwayomi-ai-chat-build', emptyOutDir: true },
});
