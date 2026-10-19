# Browser-Anmeldung (Private 0.5.3)

Unter **Einstellungen > Private Updates** 0.5.3 installieren und die Seite neu
laden. Die WebUI zeigt anschliessend eine eigene Anmeldeseite an. Es gelten
weiterhin die vorhandenen Suwayomi-Zugangsdaten.

Das native POST-Formular verwendet `autocomplete="username"` und
`autocomplete="current-password"`, damit Browser und Passwortmanager die Felder
erkennen. Ob ein Speichern-Angebot erscheint, entscheidet der Browser anhand
seiner Einstellungen. Passwort anzeigen/verbergen, Enter zum Anmelden und
helle/dunkle Darstellung funktionieren auch auf schmalen Touch-Displays.

**Angemeldet bleiben (30 Tage)** setzt ein langlebiges Sitzungscookie. Ohne diese
Option gilt eine Browsersitzung mit maximal zwoelf Stunden Laufzeit. Die
gespeicherte Sitzung uebersteht WebUI-Neustarts und Updates. Unter
**Einstellungen > Anmeldung und Abmelden** kann das aktuelle Geraet abgemeldet
werden; andere Geraete behalten ihre eigene Sitzung. Danach oeffnet sich wieder
das Anmeldeformular. Ein vorher angeforderter Manga-/Kapitelpfad wird nach der
Anmeldung wieder geoeffnet.

## Umsetzung und Grenzen

Das Passwort wird vom Suwayomi-Server geprueft. Der Gateway verwendet intern
weiterhin dessen Basic Auth und veraendert weder Serverkennwort noch Stack.
Sitzungen bestehen aus zufaelligen 256-Bit-Tokens in HttpOnly-/SameSite=Lax-
Cookies; HTTPS-Anmeldungen setzen zusaetzlich Secure. Im Browser werden weder
Passwort noch Basic-Auth-Wert im Local Storage hinterlegt. Native API-Aufrufe,
Bilder, Exporte und WebSocket-Verbindungen erhalten die geprueften Zugangsdaten
intern; das Gateway-Sitzungscookie wird nicht an den Backend-Server weitergereicht.

Der persistente Ordner `/update/browser-auth` liegt im vorhandenen NAS-Mount
`/volume3/docker/suwayomi/updater/browser-auth`. Er enthaelt einen zufaelligen
AES-256-GCM-Schluessel und pro Sitzung einen ueber den Token-Hash adressierten,
verschluesselten Datensatz. Ordnerrechte sind 0700, Dateirechte 0600. NAS-Backups
dieses Ordners sind wie andere Anmeldedaten zu schuetzen; die Verschluesselung
ersetzt keinen Schutz vor Zugriff auf den gesamten NAS-Host. Abmelden entfernt
den betreffenden Datensatz und beendet seine bestehenden WebSocket-Verbindungen.
Ungueltige oder abgelaufene Sitzungen erhalten keinen Zugriff. Wenn der
Backend-Server ein geaendertes Passwort ablehnt, wird die Sitzung verworfen.

Login und Logout pruefen Origin gegen die vorhandenen erlaubten Suwayomi-URLs
und weisen Cross-Site-Aufrufe ab. Fehlversuche werden begrenzt, Ruecksprungziele
bleiben auf derselben Seite. Gateway-Antworten liefern keine WWW-Authenticate-
Challenge; direkte Zugriffe auf den Backend-Port behalten dessen native Auth.
Ein vorhandenes Browser-Basic-Auth-Caching verhindert deshalb das Abmelden ueber
die WebUI nicht. Programmatische Basic-Auth-Aufrufe bleiben kompatibel.

Die Loginseite laeuft auch ueber den vorhandenen lokalen HTTP-Port. Eine
verschluesselte Verbindung und Secure-Cookies erfordern die konfigurierte
HTTPS-Adresse; das Update richtet keinen neuen Reverse Proxy ein.

## Validierung

Die Node-Tests pruefen Anmeldung, verschluesselte Speicherung, Neustart,
Ablauf, Manipulation, Abmelden, Passwortwechsel, andere Geraete, Origin-Schutz,
Rate Limit, sichere Rueckspruenge sowie authentifizierte APIs und WebSockets.
CI prueft das native Formular mit einem echten Chromium-Browser bei iPad-,
Mobil- und Desktop-Abmessungen sowie die Login-Tests im schreibgeschuetzten
Produktionscontainer. Die Browserbilder enthalten ausschliesslich leere Formulare.
Ein echter Safari-/Firefox-Test auf dem iPad bleibt nach der Installation noetig.

Formularattribute entsprechen [Apples Password-AutoFill-Dokumentation](https://developer.apple.com/documentation/security/enabling-password-autofill-on-an-html-input-element).
