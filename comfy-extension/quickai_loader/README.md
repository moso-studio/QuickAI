# QuickAI Frontend Extension

This extension adds QuickAI helpers inside ComfyUI:

- A `QuickAI Export` button beside the `Extensions` control in the top-right ComfyUI toolbar that saves the current workflow as a `.quickai` file for the plugin's Import Workflow button.
- The Bridge: moves images between Photoshop and an open ComfyUI tab (used by the plugin's Bridge section).

## Install
1. Copy this folder into your Comfy custom nodes folder:
   - Source: `QuickAI/comfy-extension/quickai_loader`
   - Destination: `ComfyUI/custom_nodes/quickai_loader`
2. Restart ComfyUI.
3. Reload Comfy web page.

## Usage

### Export

To export the active workflow, use the `QuickAI Export` button beside `Extensions` in the top-right ComfyUI toolbar. You will be prompted for a workflow name, and the browser downloads `<name>.quickai`. In the plugin, click Import Workflow and choose that file.

The `.quickai` file is a ZIP archive containing:

- `<name>.json` (API format)
- `<name>_UI.json` (normal workflow format)
- `<name>_metadata.txt` (node and widget details)

### Bridge

- Send (in the plugin) puts the canvas or a layer into the Load Image node selected in ComfyUI.
- Get (in the plugin) brings the image from the Save Image node selected in ComfyUI into Photoshop, as a new layer or inside the selected Smart Object.
