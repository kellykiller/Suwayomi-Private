# KI-Suche als Gespräch (Private 0.5.4)

Nach Installation ueber **Einstellungen > Private Updates** und Neuladen der
Seite kann die KI-Suche als Gespraech verwendet werden. Nach Vorschlaegen eine
weitere Nachricht eingeben, etwa „Mehr wie dein zweiter Vorschlag, aber ohne
Harem“ oder „Warum passt dieser Titel?“. **Mehr wie dieser Titel** uebernimmt
den konkreten Titel als Entwurf; erst **Nachricht senden** startet die Anfrage.
Enter sendet, Umschalt+Enter fuegt einen Zeilenumbruch ein.

Der Verlauf enthaelt die eigenen Nachrichten, KI-Antworten und bisherigen
Vorschlaege. Aeltere Ergebnislisten lassen sich aufklappen. Gespraeche bleiben
auf dem NAS gespeichert und koennen ueber **Gespeichertes Gespraech oeffnen**
nach einem Neuladen oder Update wieder geoeffnet werden. **Neues Gespraech**
beginnt einen neuen Verlauf und loescht keinen bisherigen Chat.

In **Nutzung und Suchhistorie** bietet jeder gespeicherte Suchauftrag mit
Ergebnis die Aktion **Gespraech fortsetzen**. Damit lassen sich auch Suchantworten
aus aelteren Versionen uebernehmen. Fruehere Anfragen ohne gespeichertes Ergebnis
koennen nicht rekonstruiert werden. Das Oeffnen oder Uebernehmen erzeugt keine
neue Modellanfrage und keinen zweiten Nutzungseintrag.

## Anzahl der Vorschlaege

**Maximale Vorschlaege pro Antwort** ist ein frei beschreibbares Zahlenfeld fuer
ganze Zahlen von **1 bis 100**. Der Wert begrenzt jede neue Antwort. Er gilt nicht
als Gesamtzahl des Gespraechs und kuerzt fruehere Antworten nicht nachtraeglich.
In den KI-Einstellungen laesst sich der Standard ebenfalls frei eingeben; ein
Wert direkt im Chat aendert den gespeicherten Standard nicht. Die KI darf weniger
Vorschlaege liefern, wenn sie keine weiteren verlaesslichen Titel kennt. Bei
reinen Rueckfragen kann sie ohne neue Titelliste antworten.

Mehr Titel erfordern mehr Ausgabe und Quellenabfragen. Das Ausgabelimit waechst
oberhalb von zehn Vorschlaegen; die bestehenden Zeitlimits bleiben bestehen.
Unvollstaendige Modellantworten oder nicht fertig gepruefte Quellen werden
weiterhin als solche angezeigt und nicht automatisch wiederholt.

## Kontext, Kosten und Speicherung

Jede neue Nachricht uebermittelt den bisherigen Gespraechsinhalt als geordnete
Benutzer-/Assistentennachrichten an dieselbe konfigurierte Responses API mit
`store: false`. Es werden keine Bildseiten oder Bibliotheksinhalte hinzugefuegt.
Titel, Begruendungen und bis zu fuenf historische Quellenbeobachtungen je Titel
helfen, Rueckbezuege zu verstehen. Fruehere Quellenbeobachtungen sind keine neue
Verfuegbarkeitspruefung. Neue Empfehlungen werden wie bisher in den ausgewaehlten
installierten Quellen gesucht.

Antworten und ihr Kontext koennen API-Kosten erzeugen. Jede Runde behaelt ihren
eigenen Nutzungseintrag mit Modell, Anfragegrenze, Tokenverbrauch und Kostenstand.
Der lokale Antwortcache beruecksichtigt jetzt auch den gesamten Gespraechskontext,
damit gleichlautende Rueckfragen aus verschiedenen Chats nicht verwechselt werden.
Es gibt keine automatische kostenpflichtige Wiederholung bei Verbindungsabbruch,
Neustart oder beim Oeffnen eines Verlaufs. Eine Nachrichtenkennung verhindert,
dass das ausdrueckliche erneute Absenden identischen Inhalts doppelt abgerechnet
wird. Mehrere Tabs koennen einen veralteten Gespraechsstand nicht still ueberschreiben.

Die Dateien liegen im vorhandenen Mount unter `/update/ai-conversations`
(NAS: `/volume3/docker/suwayomi/updater/ai-conversations`), Ordner 0700, Dateien 0600. Gespraeche werden dem geprueften Anmeldekontext zugeordnet und enthalten
keine API-Schluessel oder Suwayomi-Zugangsdaten. Aeltere Nutzungshistorie hatte
bereits gemeinsame Leserechte fuer die authentifizierte private Oberflaeche;
diese Altauftraege lassen sich ausdruecklich in einen eigenen Verlauf uebernehmen.

Grenzen: 500 gespeicherte Gespraeche, 100 Nachrichten je Gespraech, 16 MiB je
Gespraechsdatei und 240.000 Zeichen Anfragekontext. Bei Erreichen einer Grenze
wird die neue Modellanfrage vor dem Start abgewiesen; der Verlauf bleibt erhalten.
Der Kontext wird nicht stillschweigend gekuerzt.

## Pruefung

Tests simulieren die Anbieter und pruefen Rueckbezuege, Quellenbeobachtungen,
Eigentuemer, Cache-Trennung, Neustart, unbekannte Antworten, identische Wiederholung,
Altauftraege und beliebige erlaubte Anzahlen. Ein Browserlauf mit den echten
Chat-Komponenten, API-Helfern, Gateway und Suchdienst prueft ausserdem Zahleneingabe,
Enter/Shift+Enter, Titelbezug, reine Rueckfragen, Neuladen und erneutes Oeffnen.
Nur die Anbieter sowie nicht beteiligte App-Provider werden simuliert. Kein
Test sendet echte kostenpflichtige Provideranfragen.

Der Aufbau der API-Nachrichten folgt der
[offiziellen Dokumentation zum Gespraechszustand](https://developers.openai.com/api/docs/guides/conversation-state).
