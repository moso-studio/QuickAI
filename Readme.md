<div align="center">
  
# **QuickAI: ComfyUI plugin for Photoshop!**

</div>

QuickAI is a Photoshop plugin that runs ComfyUI workflows without leaving Photoshop. It sends your canvas, a layer or a selection to your own ComfyUI server, Comfy Cloud, RunComfy or RunPod. You fill in the workflow's inputs in the plugin, queue jobs, and the results come back as layers in your document. An optional ComfyUI extension exports your ComfyUI workflows for use in the plugin and adds a two-way bridge between Photoshop and an open ComfyUI tab.

<div align="center">
<img width="353" height="900" alt="screenshot" src="https://github.com/user-attachments/assets/94ee8b9a-46dc-4412-86a6-17be1f5e3f03" />
</div>

## **Installation**

[Download Latest Release](https://github.com/moso-studio/QuickAI/releases/latest)

Requirements: Photoshop 27.5 or later.

**Recommended: Photoshop 27.8 or earlier.**

#### 1. Photoshop plugin

1. Download the latest version from Releases.
2. Double-click it to install.
3. In Photoshop, open Plugins → QuickAI.

#### 2. Example custom workflows

1. Copy the example-workflows folder anywhere on your computer.
2. In the plugin, open Settings.
3. Next to Custom API Workflows 1, click … and select the example-workflows folder.
4. Click Save. The examples appear in the workflow list.

Some workflows need extra custom nodes or models installed in ComfyUI.

#### **3. ComfyUI extension**

1. Copy comfy-extension/quickai_loader into ComfyUI/custom_nodes/.
2. Restart ComfyUI and reload the ComfyUI page in your browser.

#### Plugin Setup

1. In the plugin, choose a Comfy Environment.
2. For Comfy Server, enter the server address and port.
3. Cloud environments need their respective API key set in Settings.

## **Features**

- Choose what to send: Current Canvas, Selected Layer or Selected Layer And Below.
- With an active selection, only the selected area is processed and the result is blended back in.
- Use other layers as reference images.
- Run several generations at once with Batch.
- Jobs run in the background while you keep working.
- The Jobs manager shows your last 50 jobs, each with its own log.
- Finished results are imported into the document as Smart Objects, automatically by default (Import job result automatically).
- The plugin tells you when a new version is available on GitHub (Settings > Update).

#### **Environments**

- Comfy Server: runs on your own ComfyUI, on your computer or another machine on your network.
- Comfy Cloud: requires a Comfy API key.
- RunComfy: requires a RunComfy API token.
- RunPod: requires a RunPod API token.

Workflows that use API nodes, like Nano Banana Pro or GPT Image, also require a Comfy API key, in any environment.

#### **Workflows**

- Comes with Flux.1 Kontext [pro], Flux.1 Kontext [max], Flux.2, Nano Banana Pro, OpenAI GPT Image 2 and Qwen Edit 2509.
- A set of example custom workflows is included in example-workflows/:
  - General Enhancers
  - People Enhancers
  - Depth Map
  - Background Removal
  - Upscale
- Add your own workflows with the plugin's Import Workflow button.
- Some custom workflows require custom nodes that are not available on Comfy Cloud

#### **ComfyUI extension**

The extension runs inside ComfyUI and adds two things:

- Workflow export: adds a QuickAI Export button to ComfyUI's top bar. It saves the current workflow as a .quickai file. To add that workflow to the plugin, click Import Workflow in the plugin and choose the file.
- Bridge: moves images between Photoshop and ComfyUI. The plugin's Bridge section has two buttons:
  - Send puts the canvas or a layer into the Load Image node selected in ComfyUI.
  - Get brings the image from the Save Image node selected in ComfyUI into Photoshop, as a new layer or inside the selected Smart Object.

