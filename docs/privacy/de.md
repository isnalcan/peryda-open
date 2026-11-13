<!-- Generated from shared/privacy.json by web/scripts/export-privacy.ts: edit that file, not this one. -->

# Datenschutz

*Peryda für Mac, Windows und das Web · Zuletzt aktualisiert am 13. November 2026*

[English](../../PRIVACY.md) · [Türkçe](../../docs/privacy/tr.md) · [Español](../../docs/privacy/es.md)

## Kurz gesagt

- Es gibt kein Konto und keinen Peryda-Server; keine Analyse, keine Werbung und kein Tracking. Nichts, was du liest, schreibst oder fragst, erreicht den Entwickler.
- Deine Bücher, Fäden, Notizen und Einstellungen bleiben auf deinem Gerät.
- Wenn du Pery fragst, geht die Anfrage mit deinem eigenen Schlüssel direkt von deinem Gerät an den KI-Anbieter, den du gewählt hast. Der Anbieter verarbeitet sie nach seinen eigenen Bedingungen.

Dieser Text gilt für Peryda für Mac, Windows und das Web. Die Peryda-Apps für iPhone und Android und Peryda Cloud haben eine eigene Datenschutzerklärung: peryda.com/privacy

## Was auf deinem Gerät bleibt

- Die PDF- und EPUB-Dateien, die du hinzufügst, deine Lesepositionen, Fäden und ihre Karten, Übersetzungen, Notizen, das Buchjournal und deine Einstellungen. Auf dem Mac liegen sie in Perydas eigenem, abgeschirmtem Ordner, unter Windows im App-Datenordner von Peryda für dein Windows-Konto und im Web im Speicher dieses Browsers für die Website. Wenn du die App entfernst oder die Websitedaten löschst, werden sie gelöscht.
- Deine KI-Schlüssel: auf dem Mac im macOS-Schlüsselbund; unter Windows und im Web im eigenen Speicher der App, verschlüsselt mit einem Schlüssel, den die Browser-Engine nie herausgibt. Wer dein Benutzerkonto auf dem Computer verwenden kann, könnte sie trotzdem erreichen; schalte auf einem gemeinsam genutzten Computer „Schlüssel auf diesem Gerät merken“ aus. Jeder Schlüssel wird nur an seinen eigenen Anbieter gesendet.
- Eine Sicherung, die du exportierst, ist eine Datei, die du aufbewahrst. Sie enthält nie deine Schlüssel und ist nicht verschlüsselt.
- Auf dem Mac wird der Text einer gescannten Seite auf dem Mac selbst gelesen, mit Apples eingebauter Texterkennung.
- Ein Buch kann nicht ins Internet: Peryda lädt in einem Buch keine Bilder, Schriften, Stile oder Skripte aus dem Web.

## Was an deinen KI-Anbieter geht

Nur wenn du etwas anforderst (eine Frage in einem Faden, eine Seitenübersetzung, den Text einer Seite, eine Journal-Zusammenfassung oder die Liste der Modelle, die dein Schlüssel nutzen kann), sendet die App deinem Anbieter, was diese Anfrage braucht:

- deine Anfrage und die früheren Nachrichten dieses Fadens;
- den markierten Text mit einem kurzen Abschnitt darum herum oder ein Bild des Seitenbereichs, den du ausgewählt hast;
- den Titel des Buches und die Seitenzahl;
- für eine Seitenübersetzung den Text der Seite; unter Windows und im Web ein Bild der Seite, wenn sie keinen eigenen Text hat (auch wenn du den Text einer Seite anforderst);
- für eine Journal-Zusammenfassung die Journaleinträge dieses Buches.

Dein ganzes Buch wird nie gesendet. Anfragen gehen über eine verschlüsselte Verbindung (HTTPS) direkt an den Anbieter; dazwischen gibt es keinen Peryda-Server.

Wenn du mit Gemini viele Seiten auf einmal übersetzt, gehen sie als Batch-Auftrag zum halben Preis. Google behält den Auftrag, bis er fertig ist, höchstens 48 Stunden; Peryda löscht ihn, sobald die Übersetzungen zurück sind oder wenn du das Übersetzen stoppst.

## Die Bedingungen deines Anbieters

Der Anbieter entscheidet, wie lange er speichert, was er erhält, und wofür er es verwenden darf. Lies seine Bedingungen, bevor du persönliche oder vertrauliche Texte sendest. Gut zu wissen:

- Google Gemini API: Google sagt, dass es in der kostenlosen Stufe deine Eingaben zur Verbesserung seiner Produkte nutzt und dass menschliche Prüfer sie lesen können, in der kostenpflichtigen Stufe dagegen nicht. Nutzer der Gemini API müssen mindestens 18 Jahre alt sein. Bedingungen: ai.google.dev/gemini-api/terms
- DeepSeek sagt, dass es Daten in der Volksrepublik China speichert. Datenschutzerklärung: deepseek.com
- OpenAI: openai.com/policies · Anthropic (Claude): anthropic.com/legal/privacy

## Downloads, Web-App und Updates

- Wenn du Peryda von GitHub herunterlädst, gilt für diesen Download die Datenschutzerklärung von GitHub.
- Die Web-App wird von Google Firebase Hosting ausgeliefert, das Verbindungsdaten wie deine IP-Adresse verarbeitet, um die Dateien zu liefern. Peryda hat keine Analyse und keine Protokollierung von Anfragen hinzugefügt.
- Unter Windows läuft Peryda in Microsoft Edge WebView2, einem Teil von Windows, den Microsoft aktuell hält.
- Die Apps suchen nicht von selbst nach Updates.

## Deine Rechte

Da der Entwickler über diese Apps keine personenbezogenen Daten erhält, hat er nichts, was er dir zeigen, berichtigen oder löschen könnte; du kannst alles selbst löschen, wie oben beschrieben. Für Daten bei einem Anbieter wende dich an diesen Anbieter. Peryda fragt nicht nach deinem Alter und führt keine Konten; KI-Anbieter legen ihr eigenes Mindestalter fest.

## Änderungen und Kontakt

Änderungen an diesem Text sind in der Geschichte des Projekts auf GitHub zu sehen: github.com/isnalcan/peryda-open. Fragen zum Datenschutz: privacy@peryda.com. Für Sicherheitsprobleme siehe SECURITY.md im Projekt.
