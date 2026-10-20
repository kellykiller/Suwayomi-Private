/* SPDX-License-Identifier: MPL-2.0 */
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import CssBaseline from '@mui/material/CssBaseline';
import { AiSearch } from '@/features/ai-search/AiSearch.tsx';
import { Availability } from './Availability.tsx';
import { ReaderFallback, ChapterBadges } from './NasFeatures.tsx';
import { LogsScreen } from '@/features/logs/LogsScreen.tsx';
const screen =
    location.pathname === '/reader-regression' ? (
        <ReaderFallback />
    ) : location.pathname === '/chapter-badges' ? (
        <ChapterBadges />
    ) : location.pathname === '/logs-test' ? (
        <LogsScreen />
    ) : location.pathname === '/availability-test' ? (
        <Availability />
    ) : (
        <AiSearch />
    );
i18n.load('de', {});
i18n.activate('de');
createRoot(document.getElementById('root')!).render(
    <I18nProvider i18n={i18n}>
        <ThemeProvider theme={createTheme()}>
            <CssBaseline />
            <BrowserRouter>{screen}</BrowserRouter>
        </ThemeProvider>
    </I18nProvider>,
);
