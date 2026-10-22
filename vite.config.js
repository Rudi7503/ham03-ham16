import { defineConfig } from 'vite';

export default defineConfig({
    server: {
        watch: {
            // Der Datei-Editor schreibt atomar über temporäre Dateien/Ordner
            // (z. B. ".module.js.<pid>.<uuid>.tmpdir/module.js.tmp") direkt neben
            // der Zieldatei. Vites Watcher läuft darauf in EBUSY und beendet den
            // ganzen Dev-Server mit einem unbehandelten Fehler. Diese Muster
            // gehören nicht zum Projekt und werden deshalb ignoriert.
            ignored: ['**/*.tmpdir/**', '**/*.tmp', '**/~*', '**/*.swp']
        }
    }
});
