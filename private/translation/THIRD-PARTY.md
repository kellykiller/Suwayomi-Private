# OCR and image-processing components

This private feature uses installed third-party packages; their original license files remain in the Python distributions and Debian packages in the image.

| Component                 | Purpose                                                                       | Upstream license / source                                                                |
| ------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| manga-ocr 0.1.16          | Japanese manga text recognition                                               | Apache-2.0; https://github.com/kha-white/manga-ocr                                       |
| kha-white/manga-ocr-base  | Japanese OCR model weights, revision aa6573bd10b0d446cbf622e29c3e084914df9741 | Apache-2.0 model card; https://huggingface.co/kha-white/manga-ocr-base                   |
| EasyOCR 1.7.2             | CRAFT text detection and English text recognition                             | Apache-2.0; https://github.com/JaidedAI/EasyOCR                                          |
| PyTorch / torchvision CPU | Local inference                                                               | BSD-style; https://github.com/pytorch/pytorch and https://github.com/pytorch/vision      |
| Transformers              | Japanese encoder-decoder runtime                                              | Apache-2.0; https://github.com/huggingface/transformers                                  |
| Pillow                    | Image normalization and deterministic typesetting                             | HPND; https://github.com/python-pillow/Pillow                                            |
| OpenCV                    | EasyOCR image processing dependency                                           | Apache-2.0; https://github.com/opencv/opencv                                             |
| DejaVu fonts              | German text rendering                                                         | Font licenses supplied by fonts-dejavu-core; https://dejavu-fonts.github.io/License.html |

The EasyOCR package supplies the CRAFT and English model download URLs and checks their bundled checksums at build time. Runtime inference disables downloading and runs without network access. PyTorch CPU packages avoid unnecessary CUDA dependencies.

The mokuro project (https://github.com/kha-white/mokuro, GPL-3.0) was inspected as an architectural reference for separate detection and Japanese recognition. No mokuro source, reader, or comic-text-detector submodule is copied into this project.

OCR is not guaranteed correct. In particular, manga-ocr can generate plausible text even for an image without text. Detection is applied first, and OCR results and uncertain/unsupported rendering regions remain reviewable.
