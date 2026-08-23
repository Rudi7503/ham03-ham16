# HAM LAB: Modular Edition 🚀

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![JavaScript](https://img.shields.io/badge/JavaScript-ES6+-F7DF1E?logo=javascript)](https://developer.mozilla.org/en-US/docs/Web/JavaScript)

**A modern web application for the compression, quantization, and lossy/adaptive optimization of raster images using historical HAM (Hold And Modify) modes based on the Amiga architecture, alongside flexible modular bit-formats.**

This project explores how modern image processing (perceptual metrics like Oklab/YUV, guided error feedback, and Branch-and-Bound lookahead) can be combined with restrictive, channel-based color-delta and palette architectures.

![HAM LAB Demo](https://via.placeholder.com/800x400?text=HAM+LAB+Demo+Screenshot)

## 📋 Table of Contents

- [🎨 How HAM Modes Work](#-how-ham-modes-work)
- [🧠 Encoder High-End Optimization Tricks](#-encoder-high-end-optimization-tricks)
- [🛠️ Repository Structure](#️-repository-structure)
- [🚀 Quick Start](#-quick-start)
- [📖 Usage Guide](#-usage-guide)
- [🤝 Contributing](#-contributing)
- [📄 License](#-license)

---

## 🎨 How HAM Modes Work

The term **HAM (Hold And Modify)** originates from the Commodore Amiga era. The core idea is brilliantly simple: instead of storing full RGB color values for every pixel, the state of the previous pixel is held, and only a single color channel is modified for the current pixel (**Modify**) — alternatively, it can jump to a fixed color palette (**Anchor**).

In this Modular Edition, we have generalized the concept across various bit depths and mixed sequences:

### 1. The Command Principle (Anchor vs. Delta)

Every pixel in the data stream consists of a control word split into two main commands:

- **Anchor (Palette Slot):** The pixel value directly accesses a predefined slot in the current color palette (RAM) (e.g., a 4-bit bank = 16 colors, a 6-bit bank = 32 colors). This is used to set hard edges or entirely new color clusters.
- **Delta (Channel Modification):** The command tells the decoder: *"Keep the color of the left neighbor, but change only the Red, Green, or Blue channel by a fixed step value ($\pm \text{Step}$)."*

### 2. The Modes in Detail (HAM03 to HAM16)

| Mode | Description |
|------|-------------|
| **HAM03 / HAM04 / HAM05 / HAM06** | Pure delta and anchor modes with variable bit widths (3 to 6 bits per pixel). They allow smooth color gradients by transmitting either a single channel at a time (with signs) or combined directional bits for R, G, and B depending on the bit depth. |
| **HAM08_PAL** | A powerful 8-bit mode supporting up to 128 anchor slots and high-resolution delta modifications. |
| **HAM12 / HAM16 (16-Bit Classes)** | Classic high-color modes for exceptionally dense color spaces. |
| **Mixed Sequences (e.g., HAM_32BIT_63436343)** | Here, bit depths rotate per pixel within a 32-bit data word (e.g., 4 pixels per word with varying bit allocations like 6/3/4/3 bits) to maximize bandwidth utilization. |

---

## 🧠 Encoder High-End Optimization Tricks

To extract the maximum image quality from these strict historical limitations, the encoder implemented in `core/module_paletted.js` and `core/feedback.js` uses advanced optimization algorithms:

### 1. Chunk Lookahead (Branch & Bound / Beam Search)

**The Problem:** A purely greedy encoder makes the locally best decision per pixel, which often leads into a dead end because a slightly "worse" step in the current pixel enables three perfect pixels in the next step.

**The Trick:** The encoder breaks the image into chunks (matching the word sequence) and spans a search tree across the entire chunk using a **Beam Search** (with a configurable `beamWidth`). It tests in advance which command combination yields the lowest cumulative error at the end.

### 2. Intelligent Lookahead Skipping (Performance Boost)

**The Problem:** Running a full Beam Search for every single pixel consumes an enormous amount of processing power.

**The Trick:** Using a configurable threshold (`errorThreshold`), the encoder evaluates beforehand via a greedy pre-pass whether the local error is minimal. If it falls below the threshold, the expensive lookahead is completely skipped (`skippedChunksCount`).

**Live Metric:** The UI displays real-time statistics indicating what percentage of blocks were saved computationally through this heuristic skip.

### 3. Chain Reaction Detection (Preventing Banding / Streaking)

**The Problem:** When a chunk is optimized, its ending state (accumulator) changes. This can cause unforeseen brightness jumps and ugly horizontal stripes (banding) in the direct neighboring chunk.

**The Trick (`forceLookahead`):** If a chunk was modified via lookahead and the next chunk does not set a hard color anchor, the optimization chain is mandatorily continued. Only when a block sets an anchor (hard-decoupling the path) does the lookahead switch off again. This ensures buttery-smooth, stripe-free gradients.

### 4. Perceptual Metrics & Guided Error Feedback

- **Metrics:** In addition to simple RGB and standard YUV, the encoder supports **Oklab**, **Redmean**, and weighted YUV metrics tailored to the biological properties of the human eye.
- **Feedback Loop:** Through the iterative feedback correction algorithm (`generateFeedbackTarget` using a guided filter), artifacts are specifically counteracted in subsequent passes to protect edges and fine details.

---

## 🛠️ Repository Structure
