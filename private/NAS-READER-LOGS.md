# Private 0.5.6: Kapitelstatus, Reader und Protokoll-ZIP

Die Kapitelübersicht zeigt bei gespeicherten Ergebnissen **Bereits übersetzt ·
Deutsch**, **Teilübersetzt · X/Y Seiten** oder **Übersetzt · mit offenen Stellen**.
Die Zuordnung verwendet die konkrete Kapitel-ID und die bereits vorhandene
Identitätsprüfung (Manga, Quellensortierung, Kapitelname und Titel). Zwei Ausgaben
von Kapitel 34 verschiedener Scanlatoren erhalten keinen gemeinsamen Status nur
wegen derselben Nummer. Die Anzeige erfasst lokale und Cloud-Übersetzungen.

Der Status wird beim Öffnen, bei Rückkehr ins Fenster und alle 30 Sekunden in
einem sichtbaren Fenster aktualisiert. Dazu werden gespeicherte Aufträge und die
native Kapitel-Datenbank gelesen. Es werden keine neuen Bilder heruntergeladen,
keine Übersetzung gestartet und keine kostenpflichtigen APIs aufgerufen. Fehlen
nach einem Umzug bereits gespeicherte Bilddateien, erscheint **Übersetzung
gespeichert · Dateien prüfen**. Bei einer fehlgeschlagenen Statusabfrage erscheint
ein Hinweis; fehlende Statusdaten werden nicht als Beweis einer fehlenden
Übersetzung behandelt.

Im Reader wird das Original jetzt auch dann angefordert, wenn die zuerst
ausgeführte Übersetzungsprüfung ohne Treffer oder mit einem Fehler endet.
Zuvor wurde der erste Originalabruf während dieser Prüfung übersprungen und
danach nicht nachgeholt. Bei vorhandener Übersetzung bleiben deren Seiten aktiv.
Ein Fehler `SourceNotInstalledException` erhält zusätzlich eine Erklärung zur
fehlenden Quellenerweiterung statt ausschließlich des technischen Textes.

Die eingesandte Serverdatei vom 20.10.2026 protokolliert um 23:26:14 Uhr deutscher
Zeit `Source not installed: 7819216870104067677`, beim Download für Manga 2453,
Kapitel-ID 2475. Das belegt eine fehlende Erweiterung für diesen Auftrag. Daraus
folgt nicht, dass jeder andere Manga dieselbe Ursache hat. Nach einem NAS-Umzug
muss das vollständige Suwayomi-Datenvolume mit Erweiterungen und heruntergeladenen
Seiten übernommen bzw. die fehlende Erweiterung unter **Suchen > Erweiterungen**
wiederhergestellt werden. Eine gespeicherte Kapitelübersicht allein enthält
keine Seiten. Die WebUI kann eine fehlende Erweiterung oder fehlende Dateien
nicht aus den Kapitelmetadaten rekonstruieren.

Unter **Protokolle** lädt **Alle Logs als ZIP herunterladen** alle sechs bisherigen
Kategorien in einer Datei herunter, unabhängig von Auswahl und Textfilter.
Das Archiv enthält dieselben begrenzten und bereinigten Auszüge wie die
Einzel-Downloads, inklusive gespeicherter Cloud-Aufträge im Übersetzungsprotokoll.
`manifest.json` beschreibt Erzeugungszeit, Umfang und eventuell nicht lesbare
Kategorien. Eine fehlgeschlagene Kategorie verhindert die übrigen Dateien nicht.
Es handelt sich um einen Diagnoseexport, nicht um ein Backup der Daten oder
Zugangsdaten. Die ZIP-Erstellung benötigt keine temporären Dateien und funktioniert
mit schreibgeschütztem Container-Dateisystem. Authentifizierung und Bereinigung
gelten genauso wie beim Einzelabruf; auch der interne Cloud-Token wird maskiert.

Tests prüfen das ZIP mit Python einschließlich CRC, Kategorien und Bereinigung,
die genaue Kapitelzuordnung, Teilübersetzungen und offene Stellen. Der Browserlauf
prüft die echte Reader-Umschaltlogik mit verzögerter/fehlgeschlagener
Übersetzungsprüfung, Statuskennzeichnungen und den tatsächlichen ZIP-Download.
Alle Anbieter werden simuliert; es gibt keine kostenpflichtigen Testanfragen.
