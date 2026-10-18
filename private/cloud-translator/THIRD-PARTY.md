# Zusaetzliche Decoder im Format-Update

Die Dateien werden lokal verarbeitet. Decoder laden keine Quelldateien von
externen URLs nach und erhalten keine API-Schluessel.

- Pillow 12.3.0: https://github.com/python-pillow/Pillow
- pillow-heif 1.8.1 / libheif: https://github.com/bigcat88/pillow_heif
- pypdfium2 5.14.0 / PDFium: https://github.com/pypdfium2-team/pypdfium2

Die jeweiligen Lizenzdateien liegen den installierten Python-Wheels bei.
pypdfium2 bietet Apache-2.0 / BSD-3-Clause; die enthaltene PDFium-Bibliothek
und deren Abhaengigkeiten bringen weitere Lizenzhinweise mit. Der Container
installiert die offiziellen Wheels mit ihren enthaltenen Lizenzdateien.
Die Schrift-Lizenzen liegen unveraendert unter app/font/.
