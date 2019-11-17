// -*- coding: utf-8 -*-

// Hippotronics Alexa Smart Home skill for RGB led service (hippoledd).

'use strict';

const http = require('http');
var Promise = require('promise');
var bodyJson = require("body/json");
var Colr = require("colr");

let AlexaResponse = require("./alexa/AlexaResponse");
let Config = require("./config.json");


// Setup HTTP server
const server = http.createServer(handleHttpRequest);
const port = Config.lambda_port;

server.listen(port, (err) => {
    if (err) 
    {
        return console.log("Error creating server", err);
    }

    console.log("HippoLed lambda running on port", port);
    console.log("Sending requests to remote daemon at", Config.remote_host, "port", Config.remote_port);
});


async function handleHttpRequest(request, response)
{
    console.log("Request", request.method, request.url);

    // Validate request
    var status = 200;
    var statusMessage = "";
    var message = null;             // The JSON body of the message that was sent to us

    try
    {
        if (request.method != "POST") { statusMessage = "Only POST supported"; throw 405; }
        if (! request.headers["content-type"] ) { statusMessage = "No Content-Type"; throw 400; }
        if (request.headers["content-type"] != "application/json") { statusMessage = "Has to be application/json"; throw 400; }

        // Decode body
        statusMessage = "Bad JSON body";
        message = await new Promise((resolve, reject) => {
            bodyJson(request, function (err, body) {
                if (err) reject(400); // Bad request
                else resolve(body);
            });
        });

        if ( (! message.header) || (! message.header.token)) { statusMessage = "No token specified"; throw 401; }
        if ( ! message.payload ) { statusMessage = "No Alexa message"; throw 400; }

        // All is well
        statusMessage = "OK";
    } 
    catch (stat)
    {
        status = stat;
    }

    if (200 == status && null != message)
    {
        // Synchronously process Alexa message
        try
        {
            var responseObj = await handleAlexa(message.payload, message.header.token);

            var responseBody = JSON.stringify(responseObj);
            console.log("Returning to Alexa", responseBody);
            
            response.setHeader("Content-Type", "application/json");
            response.setHeader("Content-Length", responseBody.length);
            response.write(responseBody);
        }
        catch (err)
        {
            console.log("Error processing Alexa request", err);

            status = 500;
            statusMessage = "Internal server error";
        }
    }

    response.statusCode = status;
    response.status = statusMessage;
    response.end();
}

async function handleAlexa(event, token) 
{

    // Dump the request for logging - check the CloudWatch logs
    console.log("index.handler request  ——");
    console.log(JSON.stringify(event));
 
    // Validate we have an Alexa directive
    if (!('directive' in event)) return;

    // Check the payload version
    if (event.directive.header.payloadVersion !== "3") return;

    let ns = (((event.directive || {}).header || {}).namespace).toLowerCase();
    console.log("--- Alexa event:", ns);

    try
    {
        if (ns === 'alexa.discovery') {
            return await handleDiscovery();
        }

        if (ns == 'alexa' && event.directive.header.name.toLowerCase() == 'reportstate')
        {
            return await handleStateRequest(event);
        }

        // Handle one of the state change events
        var bPower = ns === 'alexa.powercontroller';
        var bBright = ns === 'alexa.brightnesscontroller';
        var bColor = ns === 'alexa.colorcontroller';
        if (bPower || bBright || bColor) return await handleStateChange(ns, event);

        // If we reach this point, we have received a request we don't understand
        throw("Unsupported request");

    } catch (err)
    {
        console.log("Error processing directive", ns, err);

        let aer = new AlexaResponse(
            {
                "name": "ErrorResponse",
                "payload": {
                    "type": "INVALID_DIRECTIVE",
                    "message": err
                }
            });

        return aer.get();
    }
}

async function handleStateRequest(event)
{
    let token = event.directive.endpoint.scope.token;
    let endpoint_id = event.directive.endpoint.endpointId;
    let correlationToken = event.directive.header.correlationToken;

    // Get current lamp state
    var state = await hippoHttpGetRequest("/webapi/lamp/" + endpoint_id);

    let ar = new AlexaResponse({
        "name": "StateReport",
        "correlationToken": correlationToken,
        "token": token,
        "endpointId": endpoint_id
    });

    // Write the new lamp state into the Alexa response
    setEndpointStateInAlexaResponse(ar, state);

    // Return Alexa response
    return ar.get();
}

async function handleStateChange(ns, event)
{
    var bPower = ns === 'alexa.powercontroller';
    var bBright = ns === 'alexa.brightnesscontroller';
    var bColor = ns === 'alexa.colorcontroller';

    let token = event.directive.endpoint.scope.token;
    let endpoint_id = event.directive.endpoint.endpointId;
    let correlationToken = event.directive.header.correlationToken;

    // Get current lamp state
    var state = await hippoHttpGetRequest("/webapi/lamp/" + endpoint_id);
    var stateChanged = false;
    var setLampData = {
        "OnChanged": false,
        "On": true,
        "BrightnessChanged": false,
        "Brightness": 0.0,
        "ColorChanged": false,
        "Red"  : 0,
        "Green": 0,
        "Blue" : 0
    };
    
    // Alter lamp state
    if (bPower) 
    { 
        setLampData.OnChanged = true;
        stateChanged = true;
        changeStatePower(setLampData, state, event.directive.header.name);
    }
    else if (bBright) 
    {
        setLampData.BrightnessChanged = true;
        stateChanged = true;
        changeStateBright(setLampData, state, event.directive.header.name, event.directive.payload);
    }
    else if (bColor) 
    {
        setLampData.ColorChanged = true;
        stateChanged = true;
        changeStateColor(setLampData, state, event.directive.payload);
    }
    
    // Set lamp state
    var postPromise = null;
    if (stateChanged)
        postPromise = hippoHttpPostRequest("/webapi/lampstate/" + endpoint_id, setLampData, token);

    let ar = new AlexaResponse({
        "correlationToken": correlationToken,
        "token": token,
        "endpointId": endpoint_id
    });

    // Write the new lamp state into the Alexa response
    setEndpointStateInAlexaResponse(ar, state);

    // Make sure the post request to Hippoledd succeeds before returning
    if (postPromise != null) await(postPromise);

    // Return Alexa response
    return ar.get();
}


function setEndpointStateInAlexaResponse(ar, state)
{
    ar.addContextProperty({ "namespace": "Alexa.PowerController", "name": "powerState", "value": state.On ? "ON" : "OFF", "uncertaintyInMilliseconds": 1000 });
    ar.addContextProperty({ "namespace": "Alexa.EndpointHealth", "name": "connectivity", "value": { "value": state.Online ? "OK" : "UNREACHABLE" }, "uncertaintyInMilliseconds": 1000 });

    // Brightness and/or color?
    let brightnessSupported = state.NodeType < 4;
    let colorSupported = state.NodeType == 3;

    if (brightnessSupported || colorSupported)
    {
        // Convert RGB to HSB
        var colr = Colr.fromRgb(state.Red, state.Green, state.Blue);
        var hsv = colr.toHsvObject();

        // Brightness
        if (brightnessSupported)
        {
            ar.addContextProperty({ "namespace": "Alexa.BrightnessController", "name": "brightness", "value": hsv.v, "uncertaintyInMilliseconds": 1000 });
        }

        // Color
        if (colorSupported)
        {
            ar.addContextProperty({ "namespace": "Alexa.ColorController", "name": "color", "value": { "hue": hsv.h, "saturation": hsv.s / 100.0, "brightness": hsv.v / 100.0 }, "uncertaintyInMilliseconds": 1000 });
        }
    }

}

function changeStatePower(setLampData, state, onoff)
{
    if (onoff === "TurnOn") {
        state.On = setLampData.On = true;
    }
    else if (onoff == "TurnOff")
    {
        state.On = setLampData.On = false;
    }
}

function changeStateBright(setLampData, state, parameter, payload)
{
    var existingCol = Colr.fromRgb(state.Red, state.Green, state.Blue);
    var existingColHsv = existingCol.toHsvObject();
    var existingBrightness = existingColHsv.v;
    var newBrightness = existingBrightness;

    if (parameter.toLowerCase() == 'adjustbrightness')
    {
        // Brightness delta
        var delta = payload.brightnessDelta;
        newBrightness = existingBrightness + delta;
    }
    else if (parameter.toLowerCase() == 'setbrightness')
    {
        // Absolute brightness value
        newBrightness = payload.brightness;
    }

    // Bounds check. We clip brightness at 95%, otherwise we lose color information
    if (newBrightness < 0) newBrightness = 0;
    if (newBrightness > 100) newBrightness = 100;
//    if (newBrightness > 95) newBrightness = 95;
    setLampData.Brightness = newBrightness / 100.0;

    if (newBrightness != existingBrightness)
    {
        // A change! Set in state
        var newCol = Colr.fromHsv(existingColHsv.h, existingColHsv.s, newBrightness);
        var newColRgb = newCol.toRgbObject();

        state.Red = newColRgb.r;
        state.Green = newColRgb.g;
        state.Blue = newColRgb.b;
    }

    // If brightness >0 and state is off, turn on
    // Alexa does not send a separate power event
    if (newBrightness > 0 && state.On == false) 
    {
        state.On = setLampData.On = true;
        setLampData.OnChanged = true;
    }
}

function changeStateColor(setLampData, state, payload)
{
    var newCol = Colr.fromHsv(payload.color.hue, payload.color.saturation * 100, payload.color.brightness * 100);
    var newColHsv = newCol.toHsvObject();
    var existingCol = Colr.fromRgb(state.Red, state.Green, state.Blue);
    var existingColHsv = existingCol.toHsvObject();

    // Set new color. Keep brightness constant per Alexa user experience directive.
    var colToSet = Colr.fromHsv(newColHsv.h, newColHsv.s, existingColHsv.v);
    var colToSetRgb = colToSet.toRgbObject();

    state.Red = setLampData.Red = colToSetRgb.r;
    state.Green = setLampData.Green = colToSetRgb.g;
    state.Blue = setLampData.Blue = colToSetRgb.b;
}

async function handleDiscovery()
{
    let adr = new AlexaResponse({ "namespace": "Alexa.Discovery", "name": "Discover.Response" });
    let capability_alexa = adr.createPayloadEndpointCapability();

    // Get information from Hippotronics service
    var response = await hippoHttpGetRequest("/webapi/lamps");
    console.log("Hippo discovery lamp status: ");
    console.log(response);

    response.forEach(function (lamp) 
    {
        // All endpoints support power and connectivity
        let capability_alexa_powercontroller = adr.createPayloadEndpointCapability({ "interface": "Alexa.PowerController", "supported": [{ "name": "powerState" }], "proactivelyReported": false, "retrievable": true });
        let capability_alexa_reporting = adr.createPayloadEndpointCapability({ "interface": "Alexa.EndpointHealth", "supported": [{ "name": "connectivity" }], "proactivelyReported": false, "retrievable": true });

        let capabilities = [capability_alexa_powercontroller, capability_alexa_reporting];

        // Lamp types:
        //public enum NodeType
        //{
        //    Unknown,                // Not determined yet
        //    LampDimmable,           // One color, dimmable 0-100%
        //    LampColor1D,            // E.g. cool white to warm white, dimmable 0-100%
        //    LampColorRGB,           // RGB led
        //    Switch                  // On/off switch (e.g. relay)
        //}

        // 0 is actually equivalent to 3 - used for very old interfaces that didn't expose capabilities yet
        // NodeType > 4 should not occur, but is not supported by this daemon, so we also treat it as unknown.
        let nodeType = lamp.NodeType;
        if (nodeType == 0 || nodeType > 4) nodeType = 3;

        let brightnessSupported = nodeType < 4;
        let colorSupported = nodeType == 3;

        // TODO: we don't support color temp yet
    
        // Brightness control
        if (brightnessSupported) {
            let capability_alexa_brightness = adr.createPayloadEndpointCapability({ "interface": "Alexa.BrightnessController", "supported": [{ "name": "brightness" }], "proactivelyReported": false, "retrievable": true });

            capabilities.push(capability_alexa_brightness);
        }

        // Color 
        if (colorSupported) {
            let capability_alexa_color = adr.createPayloadEndpointCapability({ "interface": "Alexa.ColorController", "supported": [{ "name": "color" }], "proactivelyReported": false, "retrievable": true });

            capabilities.push(capability_alexa_color);
        }

        // Description from type 
        let description = "Lamp";
        if (brightnessSupported) description += " with control of brightness";
        if (colorSupported) description += " and color";


        adr.addPayloadEndpoint({ "friendlyName": lamp.Name, "endpointId": lamp.Name, "manufacturerName": "HippoTronics", "description": description, "capabilities": capabilities, "displayCategories": ["LIGHT"] });
    });

    // Send async response to Alexa
    return adr.get();
}



async function hippoHttpGetRequest(url)
{
    console.log("Executing HTTP get to", url);

    return new Promise((resolve, reject) => {
        var options = {
            host: Config.remote_host,
            port: Config.remote_port,
            path: url
        };

        http.get(options, (res) => {
            console.log("Hippotronics responds ", res.statusCode);

            if (200 == res.statusCode) 
            {
                bodyJson(res, function (err, body) {
                   if (err) reject(err);
                   else resolve(body);
                });
            }
            else reject(res.statusCode);
        });

    });
}

async function hippoHttpPostRequest(url, body)
{
    console.log("Sending POST to HippoTronics ----");
    var bodyTxt = JSON.stringify(body);
    console.log(bodyTxt);
    
    return new Promise( (resolve, reject) =>
    {
        var options = {
            host: Config.remote_host,
            port: Config.remote_port,
            path: url,
            method: 'POST',
            headers: {
                "Content-Type": "application/json",
                "Content-Length": bodyTxt.length
            }
        };
    
        var req = http.request(options, (res) => {
            console.log("Hippotronics responds ", res.statusCode);

            if (200 == res.statusCode) resolve(res.statusCode); else 
            {
                var errorMessage = "Http Error: " + res.statusCode + " " + res.statusMessage;
                console.log(errorMessage);
                reject(errorMessage);
            }
        });
        
        req.on('error', (error) => {
            console.log("On Error HTTP Request: " + error);
            reject(error)
        });
        
        req.write(bodyTxt);
        req.end();
    });
}

