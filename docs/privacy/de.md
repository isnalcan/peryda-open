<!-- Generated from shared/privacy.json by web/scripts/export-privacy.ts: edit that file, not this one. -->

# Datenschutz

*Peryda für Mac, Windows und das Web · Zuletzt aktualisiert am 16. November 2026*

[English](../../PRIVACY.md) · [Türkçe](../../docs/privacy/tr.md) · [Español](../../docs/privacy/es.md)

## Kurz gesagt

- Es gibt kein Konto und keinen Peryda-Server; keine Analyse, keine Werbung und kein Tracking. Nichts, was du liest, schreibst oder fragst, erreicht den Entwickler.
- Die Mac- und Windows-Apps suchen nur nach neuen Versionen, wenn du es erlaubst.
- Deine Bücher, Fäden, Notizen und Einstellungen bleiben auf deinem Gerät.
- Wenn du Pery fragst, geht die Anfrage mit deinem eigenen Schlüssel direkt von deinem Gerät an den KI-Anbieter, den du gewählt hast. Der Anbieter verarbeitet sie nach seinen eigenen Bedingungen.

Dieser Text gilt für Peryda für Mac, Windows und das Web.

## Was auf deinem Gerät bleibt

- Die PDF- und EPUB-Dateien, die du hinzufügst, deine Lesepositionen, Fäden und ihre Karten, Übersetzungen, Notizen, das Buchjournal und deine Einstellungen. Auf dem Mac liegen sie in Perydas eigenem, abgeschirmtem Ordner, unter Windows im App-Datenordner von Peryda für dein Windows-Konto und im Web im Speicher dieses Browsers für die Website. Im Web werden sie gelöscht, wenn du die Websitedaten löschst. Das Entfernen der App allein löscht sie nicht: Um alles zu entfernen, lösche zuerst deine Schlüssel in Perydas Einstellungen und entferne dann die App; lösche auf dem Mac außerdem den Ordner Library/Containers/com.isnalcan.peryda.mac in deinem Benutzerordner, und setze unter Windows beim Deinstallieren das Häkchen, das die App-Daten löscht.
- Eine Sicherung, die du exportierst, ist eine Datei, die du aufbewahrst. Sie enthält deine Bücher und alles, was du in Peryda geschrieben oder bekommen hast (Fäden, Übersetzungen, ausgelesene Seiten, das Journal), aber nie deine Schlüssel, und sie ist nicht verschlüsselt.
- Auf dem Mac wird der Text einer gescannten Seite auf dem Mac selbst gelesen, mit Apples eingebauter Texterkennung, außer du wählst „Mit Pery auslesen“: Dann geht ein Bild der Seite an deinen Anbieter.
- Ein Buch kann nicht ins Internet: Peryda lädt in einem Buch keine Bilder, Schriften, Stile oder Skripte aus dem Web.

## Wie deine Schlüssel geschützt sind

Deine Schlüssel werden nur auf diesem Gerät gespeichert und nur an ihren eigenen Anbieter gesendet. Im Einzelnen:

- Auf dem Mac liegen sie im macOS-Schlüsselbund, der sie verschlüsselt und entsperrt, wenn du dich an deinem Mac anmeldest; eine andere App kommt nur an sie heran, wenn du es erlaubst.
- Unter Windows und im Web liegen sie im eigenen Speicher der App auf diesem Gerät, mit AES-256 verschlüsselt. Den Schlüssel zum Entschlüsseln erzeugt die Browser-Engine (unter Windows Microsoft Edge WebView2), die ihn nie herausgibt; deshalb stehen deine Schlüssel in keiner Datei als lesbarer Text.
- Auch die Grenze solltest du kennen: Diese Verschlüsselung schützt nicht vollständig vor jemandem, der dein Benutzerkonto auf dem Computer verwenden kann, oder vor Schadsoftware, die dort läuft. Schalte auf einem gemeinsam genutzten Computer „Schlüssel auf diesem Gerät merken“ aus: Dann werden deine Schlüssel nie gespeichert und beim Beenden der App (im Web beim Schließen der Seite) vergessen. Im Web außerdem: Eine Browsererweiterung, die jede Website lesen darf, kann alles auf einer offenen Seite sehen; nutze Peryda in einem Browser, in dem nur Erweiterungen laufen, denen du vertraust.
- Jeder Schlüssel geht über eine verschlüsselte Verbindung (HTTPS) nur an seinen eigenen Anbieter, im Kopf der Anfrage, nie in der Adresse. Unter Windows und im Web erlaubt die Sicherheitsrichtlinie der App (Content Security Policy) keine Verbindung zu einer anderen Adresse als ihren eigenen Dateien und diesen vier Anbietern. Peryda lädt keinen Code aus dem Internet und enthält keine Skripte anderer Firmen wie Werbung, Analyse oder Chat-Widgets.
- Deine Schlüssel gelangen nie in Perydas Sicherungen oder exportierte Dateien. (Die Sicherungen des Mac selbst, etwa Time Machine, enthalten den Schlüsselbund; dort bleibt er durch die Verschlüsselung von macOS geschützt.)
- Unser Rat: Lege für Peryda einen eigenen Schlüssel an und setze bei deinem Anbieter ein Ausgabenlimit. Wenn du glaubst, dass ein Schlüssel in fremde Hände geraten ist, widerrufe ihn auf der Website des Anbieters; ein widerrufener Schlüssel funktioniert nicht mehr.
- Peryda ist Open Source: Jeder kann im Code prüfen, wie Schlüssel gespeichert und gesendet werden (github.com/isnalcan/peryda-open).

## Was an deinen KI-Anbieter geht

Nur wenn du etwas anforderst (eine Frage in einem Faden, eine Seitenübersetzung, den Text einer Seite, eine Journal-Zusammenfassung oder die Liste der Modelle, die dein Schlüssel nutzen kann), sendet die App deinem Anbieter, was diese Anfrage braucht:

- deine Anfrage und die früheren Nachrichten dieses Fadens;
- den markierten Text mit einem kurzen Abschnitt darum herum oder ein Bild des Seitenbereichs, den du ausgewählt hast;
- den Titel des Buches und die Seitenzahl;
- für eine Seitenübersetzung den Text der Seite oder ein Bild der Seite, wenn sie keinen eigenen Text hat; wenn du „Mit Pery auslesen“ wählst, ein Bild jeder gewählten Seite;
- für eine Journal-Zusammenfassung die Journaleinträge dieses Buches.

Gesendet werden nur die Seiten, die du anforderst, und nichts von selbst; ein Seitenbereich (höchstens 200 Seiten auf einmal) sendet jede seiner Seiten. Anfragen gehen über eine verschlüsselte Verbindung (HTTPS) direkt an den Anbieter; dazwischen gibt es keinen Peryda-Server.

Wenn du mit Gemini mehr als zwei Seiten auf einmal übersetzt oder ausliest, gehen sie als Batch-Auftrag zum halben Preis. Google bearbeitet einen Auftrag höchstens 48 Stunden. Peryda löscht den Auftrag bei Google, sobald die Ergebnisse zurück sind (während das Buch in Peryda geöffnet ist), wenn du stoppst oder wenn du deinen Gemini-Schlüssel änderst. Google sagt nicht, wie lange es einen fertigen, nicht gelöschten Auftrag aufbewahrt.

## Die Bedingungen deines Anbieters

Der Anbieter entscheidet, wie lange er speichert, was er erhält, und wofür er es verwenden darf. Lies seine Bedingungen, bevor du persönliche oder vertrauliche Texte sendest. Gut zu wissen:

- Google Gemini API: Google sagt, dass es in der kostenlosen Stufe deine Eingaben zur Verbesserung seiner Produkte nutzt und dass menschliche Prüfer sie lesen können, in der kostenpflichtigen Stufe dagegen nicht. Nutzer der Gemini API müssen mindestens 18 Jahre alt sein. Bedingungen: ai.google.dev/gemini-api/terms
- DeepSeek sagt, dass es Daten in der Volksrepublik China speichert. Datenschutzerklärung: deepseek.com
- OpenAI: openai.com/policies · Anthropic (Claude): anthropic.com/legal/privacy

## Downloads, Web-App und Updates

- Wenn du Peryda von GitHub herunterlädst, gilt für diesen Download die Datenschutzerklärung von GitHub.
- Die Web-App wird von Google Firebase Hosting ausgeliefert, das Verbindungsdaten wie deine IP-Adresse verarbeitet, um die Dateien zu liefern. Peryda hat keine Analyse und keine Protokollierung von Anfragen hinzugefügt.
- Unter Windows läuft Peryda in Microsoft Edge WebView2, einem Teil von Windows, den Microsoft aktuell hält.
- Die Mac- und Windows-Apps suchen nie ohne deine Erlaubnis nach einer neuen Version. Sie fragen beim zweiten Start; wenn du es erlaubst, holen sie etwa einmal am Tag eine kleine Versionsdatei von GitHub. Wie bei jeder Webanfrage kann GitHub dabei deine IP-Adresse sowie Name und Version der anfragenden App sehen. Über deine Bücher, Notizen, Schlüssel oder deinen Computer wird nichts gesendet. Du kannst diese Suche jederzeit in den Einstellungen ein- oder ausschalten.
- Ein Update wird nur installiert, wenn es mit Perydas Update-Schlüssel signiert ist; eine Datei mit falscher Signatur oder eine veränderte Datei wird abgelehnt. Wird eine neue Version gefunden, fragt die App vor der Installation; auf dem Mac kannst du auch festlegen, dass Updates automatisch installiert werden.
- Die Web-App prüft nichts gesondert: Jedes Mal, wenn du die Seite öffnest, bekommst du die neueste Version.

## Deine Rechte

Da der Entwickler über diese Apps keine personenbezogenen Daten erhält, hat er nichts, was er dir zeigen, berichtigen oder löschen könnte; du kannst alles selbst löschen, wie oben beschrieben. Für Daten bei einem Anbieter wende dich an diesen Anbieter. Peryda fragt nicht nach deinem Alter und führt keine Konten; KI-Anbieter legen ihr eigenes Mindestalter fest.

## Änderungen und Kontakt

Änderungen an diesem Text sind in der Geschichte des Projekts auf GitHub zu sehen: github.com/isnalcan/peryda-open. Fragen zum Datenschutz: privacy@peryda.com. Für Sicherheitsprobleme siehe SECURITY.md im Projekt.
