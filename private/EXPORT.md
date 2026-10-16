# Bibliothek auf das eigene Gerät exportieren (0.4.9)

In der Bibliothek das Menü eines Manga öffnen oder mehrere Manga auswählen und
**Auf Gerät speichern …** wählen. Auf der Manga-Detailseite steht dieselbe Funktion
als Speichern-Symbol bereit. Einzelne oder mehrere Kapitel lassen sich über deren
Kapitelmenü exportieren.

Der Dialog bietet zwei Formate:

- **CBZ**: Ein einzelnes Kapitel ergibt eine CBZ-Datei mit nummerierten Bildern im
  Archivwurzelverzeichnis. Bei mehreren Kapiteln enthält ein ZIP pro Manga eine
  eigene CBZ-Datei je Kapitel.
- **Kapitelordner**: Ein ZIP enthält einen Manga-Ordner und darin einen Unterordner
  je Kapitel. Die Kapitelverzeichnisse haben einen eindeutigen, fortlaufenden
  Präfix in Suwayomis ursprünglicher Kapitelreihenfolge. Seiten heißen `0001.jpg`,
  `0002.png` usw.; das Originalformat und die Bildbytes bleiben erhalten.

CBZ ist ZIP-basiert. Es wird kein RAR-Archiv erzeugt und keine ZIP-Datei als CBR
ausgegeben. Ein Browser wie Firefox kann keinen beliebigen lokalen Ordner direkt
beschreiben. Deshalb wird die Ordnerstruktur als ZIP heruntergeladen und danach
lokal entpackt; der Zielort hängt von den Download-Einstellungen des Browsers ab.

Fehlen Kapitel auf dem NAS, zeigt der Dialog deren Anzahl. **Herunterladen und
speichern** reiht sie in die vorhandene Suwayomi-Downloadwarteschlange ein und
wartet auf vollständige Downloads. Schließen bricht nur diese Vorbereitung ab,
nicht bereits eingereihte NAS-Downloads. Solange weitere Kapitel fertig werden,
wartet die Vorbereitung auch bei langen Manga weiter. Erst nach 30 Minuten ohne
ein weiteres vollständiges Kapitel wird mit einem Hinweis gestoppt. Fehlende Kapitel werden nicht still
weggelassen. Leere Manga müssen zuerst in Suwayomi aktualisiert werden.

Der Geräteexport verwendet ausschließlich Suwayomis lokale CBZ-Ausgabe mit
`markAsRead=false`, verändert weder Lesefortschritt noch Originaldateien und
startet keine OCR- oder KI-Aufrufe. Der Dialog bestätigt nur die Übergabe an den
Browser, nicht den erfolgreichen Abschluss des Dateidownloads. Fehler während
der Übertragung erscheinen in der Downloadanzeige des Browsers.

Das Archiv wird gestreamt und unterstützt ZIP64. Auf dem NAS wird jeweils nur
ein Kapitelarchiv und gegebenenfalls dessen CBZ-Ausgabe temporär im bestehenden
schreibbaren NAS-Mount `/update/exports` gehalten; das schreibgeschützte
Container-Dateisystem bleibt unverändert.
Temporäre Dateien werden nach Abschluss oder Verbindungsabbruch entfernt.
Kapitelarchive sind auf 1 GiB, entpackte Bilddaten auf 2 GiB je Kapitel und einzelne
Bilder auf 128 MiB begrenzt. Seitenanzahl, sichere Dateipfade und eindeutige
Archivnamen werden überprüft. Originalbilder werden nicht neu komprimiert.
Pro Auswahl sind maximal 20 Manga oder 1.000 einzelne Kapitel möglich, insgesamt
maximal 20.000 Kapitel und 10.000 Seiten je Kapitel.

Die Exportfunktionen verwenden dieselbe vorhandene Suwayomi-Basic-Auth wie die
anderen privaten Funktionen. Kein Zugangsschlüssel wird in Downloadlinks oder
Dateinamen geschrieben. Nach Aktivierung über das private Update den Browser
neu laden. Ein echter Bibliotheksexport auf dem NAS bleibt als Abnahmetest nötig.
