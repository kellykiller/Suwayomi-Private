# Kapitelprüfung vor der Anzeige (Private 0.5.5)

Quellenansichten (Beliebt, Neu und Suche), die globale Suche und manuelle
Migrationssuchen zeigen nur Treffer, deren Kapitelliste erfolgreich geprüft wurde
und mindestens einen Eintrag enthält. Das gilt für MangaDex und alle anderen
installierten Quellen, jeweils mit deren eingestellten Sprachen und Filtern.
Eine noch nicht abgerufene Datenbank-Kapitelzahl von null gilt nicht als Beweis
für einen leeren Manga.

Die Prüfung ruft die native Suwayomi-Funktion `fetchMangaAndChapters` mit
`fetchManga: false` und `fetchChapters: true` auf. Sie lädt weder Bildseiten noch
KI-Antworten. Kapitelverfügbarkeit bedeutet hier eine vorhandene Kapitelliste;
ob jede Bildseite eines Kapitels erreichbar ist, wird damit nicht behauptet.
Die bestehenden Bibliothekseinträge und ihre direkten Detailseiten bleiben
erreichbar; es werden keine Manga oder Lesefortschritte gelöscht.

Während der Prüfung erscheint ein Hinweis. Ungeprüfte oder fehlgeschlagene
Treffer werden nicht als lesbar angezeigt. Fehler erhalten einen gesonderten
Hinweis mit **Erneut prüfen** und werden niemals als erfolgreiche Null-Treffer
gespeichert. Bereits erfolgreich geprüfte Treffer bleiben beim Wiederholen
erhalten. Quellenfehler können weiterhin auftreten; dieser Filter behebt keinen
Fehler innerhalb einer Erweiterung oder der Android-Kompatibilität des Servers.

Prüfungen werden innerhalb der geöffneten Oberfläche zusammengeführt: höchstens
drei Quellen gleichzeitig, eine aktive Kapitelprüfung je Quelle und mindestens
350 ms zwischen Starts innerhalb einer Warteschlange. Verlassen einer Suche
bricht ihre nicht mehr benötigten Prüfungen ab. Ein anderer gleichzeitig
wartender Verbraucher derselben Prüfung bleibt erhalten. Jede Anfrage hat
20 Sekunden Zeitlimit. Cache: lesbar zehn Minuten, leer zwei Minuten, Fehler
15 Sekunden; höchstens 2.000 Einträge. **Erneut prüfen** verwirft Fehler sofort.
Der Cache enthält keine Zugangsdaten und wird beim Neuladen neu aufgebaut.
Das erste Öffnen einer Quellenliste kann durch die Kapitelprüfung länger dauern.

Eine vollständig leer geprüfte Ergebnisseite führt automatisch zur nächsten
Seite, sofern vorhanden. Die Quellenansicht überspringt höchstens zehn solche
Seiten pro Ansicht; die globale Suchvorschau prüft höchstens zehn Seiten
automatisch. Danach kann über **Weitere Treffer prüfen** fortgesetzt werden.
Unbekannte Ergebnisse oder Quellenfehler lösen kein unbegrenztes Weiterblättern
aus. Nach Änderung von Quelle, Suchtext oder Filtern beginnt die Prüfung für die
jeweils neuen Treffer.

Auch die KI-Suche übernimmt Quellenverknüpfungen erst nach erfolgreicher
Kapitelprüfung. Ein leerer Treffer beendet die Suche nach einer lesbaren Ausgabe
nicht; weitere Ergebnisseiten und alternative Titel werden innerhalb der
bisherigen Suchgrenzen geprüft. Es wird keine zusätzliche Modellanfrage zum
Auffüllen der Liste gestellt. Angezeigt werden nur Empfehlungen mit mindestens
einer bestätigten lesbaren Quelle. Das gilt auch beim Anzeigen alter gespeicherter
KI-Gespräche; die gespeicherten Antworten und Kosten werden nicht verändert.

Tests prüfen tatsächliche Kapitellisten statt unfertiger Datenbankzahlen,
Fehler/Null-Treffer, Cache und Ablauf, Zusammenführung, Parallelitätsgrenzen,
Abbruch, explizite Wiederholung und die Weitersuche bei leeren KI-Treffern. Der
Browserlauf prüft den echten React-Hook, Ergebnisanzeige, Quellenfehler,
Wiederholung und Suchwechsel mit simulierten Quellen.
