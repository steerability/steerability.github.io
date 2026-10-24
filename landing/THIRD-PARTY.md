# Third-party notices

The landing page loads one script, `steer-engine.js`. Two parts of it derive from open-source projects;
keep these notices with the code if you ship it.

## Paper Shaders (dithering fragment shader)

`Steer.dither()` mounts the dithering fragment shader from `@paper-design/shaders` 0.0.82, used verbatim.

Copyright paper.design. Licensed under the Apache License, Version 2.0; you may not use this file except in
compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0.
Unless required by applicable law or agreed to in writing, software distributed under the License is distributed
on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.

NOTICE: Powered by Paper Shaders: https://shaders.paper.design

## asciify-engine (character field)

`Steer.glyphField()` is a small re-implementation of the glyph-field idea in asciify-engine 4.32.7
(glyph atlas, tone to glyph with a 4x4 Bayer blend, generated scenes). Its fluid-wake shader and the orb,
drift, swell, ripple and halo scenes are adapted from `src/field/field-shaders.ts`.

MIT License. Copyright (c) 2026 ayangabryl.

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
documentation files (the "Software"), to deal in the Software without restriction, including without limitation
the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and
to permit persons to whom the Software is furnished to do so, subject to the following conditions: The above
copyright notice and this permission notice shall be included in all copies or substantial portions of the
Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT
LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT
SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
DEALINGS IN THE SOFTWARE.

## Typefaces

Loaded from Google Fonts under the SIL Open Font License: Bricolage Grotesque, Geist, Geist Mono, Newsreader,
Spline Sans Mono, IBM Plex Mono, IBM Plex Sans, Instrument Serif.
