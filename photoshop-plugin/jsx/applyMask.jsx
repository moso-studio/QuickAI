#target photoshop

/**
 * Headless entry point to be executed by the UXP plugin.
 * * @param {Number} targetLayerID The ID of the layer that will receive the mask.
 * @param {Number} sourceLayerID The ID of the layer that will provide the RGB data.
 * @returns {String} A status message ("Success" or an "Error: ..." string) that UXP can read.
 */
function applySourceRGBToTargetMask(targetLayerID, sourceLayerID) {
    if (app.documents.length === 0) {
        return "Error: No document open.";
    }

    if (app.activeDocument.mode !== DocumentMode.RGB) {
        return "Error: Document must be in RGB mode.";
    }

    if (!targetLayerID || !sourceLayerID) {
        return "Error: Target and Source Layer IDs must be provided.";
    }

    if (targetLayerID === sourceLayerID) {
        return "Error: Target and Source layers cannot be the same.";
    }

    try {
        // Suspend history to group the actions into a single undo step
        app.activeDocument.suspendHistory("Apply RGB as Mask", "processApplyMask(" + targetLayerID + ", " + sourceLayerID + ");");
        return "Success";
    } catch (e) {
        return "Error: " + e.message;
    }
}

// --- The Core Workflow ---

function processApplyMask(targetLayerID, sourceLayerID) {
    // Step 1: Select the layer that will receive the mask
    selectLayerByID(targetLayerID);
    
    // Step 2: Make sure it has a mask, then target it
    ensureLayerMask();
    
    // Step 3: Apply Image (Source ID, RGB Channel (0), Normal Blend, 100% Opacity)
    doApplyImage(sourceLayerID, 0, "Normal", 100);
}

// --- Action Manager Helper Functions ---

function selectLayerByID(id) {
    var desc = new ActionDescriptor();
    var ref = new ActionReference();
    ref.putIdentifier(charIDToTypeID("Lyr "), id);
    desc.putReference(charIDToTypeID("null"), ref);
    desc.putBoolean(charIDToTypeID("MkVs"), false);
    executeAction(charIDToTypeID("slct"), desc, DialogModes.NO);
}

function ensureLayerMask() {
    try {
        // Attempt to select an existing mask
        selectLayerMask();
    } catch(e) {
        // If it fails, create one, then select it
        addRevealAllMask();
        selectLayerMask();
    }
}

function addRevealAllMask() {
    var desc = new ActionDescriptor();
    desc.putClass(charIDToTypeID("Nw  "), charIDToTypeID("Chnl"));
    var ref = new ActionReference();
    ref.putEnumerated(charIDToTypeID("Chnl"), charIDToTypeID("Chnl"), charIDToTypeID("Msk "));
    desc.putReference(charIDToTypeID("At  "), ref);
    desc.putEnumerated(charIDToTypeID("Usng"), charIDToTypeID("UsrM"), charIDToTypeID("RvlA"));
    executeAction(charIDToTypeID("Mk  "), desc, DialogModes.NO);
}

function selectLayerMask() {
    var desc = new ActionDescriptor();
    var ref = new ActionReference();
    ref.putEnumerated(charIDToTypeID("Chnl"), charIDToTypeID("Chnl"), charIDToTypeID("Msk "));
    desc.putReference(charIDToTypeID("null"), ref);
    desc.putBoolean(charIDToTypeID("MkVs"), false);
    executeAction(charIDToTypeID("slct"), desc, DialogModes.NO);
}

function doApplyImage(sourceLayerID, channelIndex, blendMode, opacity) {
    var idAppI = charIDToTypeID("AppI");
    var desc = new ActionDescriptor();
    var idWith = charIDToTypeID("With"); 
    var descWith = new ActionDescriptor();
    
    var idT = charIDToTypeID("T   ");
    var ref = new ActionReference();
    
    // We strictly want the RGB channel for this requirement
    var targetChannel = charIDToTypeID("RGB ");
    
    ref.putEnumerated(charIDToTypeID("Chnl"), charIDToTypeID("Chnl"), targetChannel);
    
    var idLyr = charIDToTypeID("Lyr ");
    ref.putIdentifier(idLyr, sourceLayerID);
    descWith.putReference(idT, ref);
    
    // Hardcoded to Normal blending mode for standard mask application
    var idClcl = charIDToTypeID("Clcl");
    var idClcn = charIDToTypeID("Clcn");
    descWith.putEnumerated(idClcl, idClcn, charIDToTypeID("Nrml"));
    
    var idOpct = charIDToTypeID("Opct");
    var idPrct = charIDToTypeID("#Prc");
    descWith.putUnitDouble(idOpct, idPrct, opacity);
    
    var idClclObj = charIDToTypeID("Clcl");
    desc.putObject(idWith, idClclObj, descWith);
    executeAction(idAppI, desc, DialogModes.NO);
}