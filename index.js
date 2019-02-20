// -*- coding: utf-8 -*-

// Hippotronics Alexa Smart Home skill for RGB led service (hippoledd).

'use strict';

const http = require('http');
const https = require('https');
var Promise = require('promise');
var bodyJson = require("body/json");
var Colr = require("colr");

let AlexaResponse = require("./alexa/AlexaResponse");

const HIPPO_HOST = "192.168.1.6";
const HIPPO_PORT = 9000;

const ALEXA_HOST = "api.eu.amazonalexa.com";
const ALEXA_URL = "/v3/events";


// Setup HTTP server
const server = http.createServer(handleHttpRequest);
const port = 3001;

server.listen(port, (err) => {
    if (err) 
    {
        return console.log("Error creating server", err);
    }

    console.log("HippoLed lambda running on port", port);
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

    // Return 200 if message well received, or error code if not
    // In case of 200, additional processing will take place asynchronously
    // (and response to Alexa).
    response.statusCode = status;
    response.status = statusMessage;
    response.end();

    if (200 == status && null != message)
    {
        // (asynchronously) process Alexa message
        handleAlexa(message.payload, message.header.token);
    }
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

    let namespace = ((event.directive || {}).header || {}).namespace;


    try{

    
        if (namespace.toLowerCase() === 'alexa.discovery') {
            await handleDiscovery(token);
            return;
        }

        var bPower = namespace.toLowerCase() === 'alexa.powercontroller';
        var bBright = namespace.toLowerCase() === 'alexa.brightnesscontroller';
        var bColor = namespace.toLowerCase() === 'alexa.colorcontroller';
        var bStateChange = bPower || bBright || bColor;

        if (bStateChange) 
        {
            let endpoint_id = event.directive.endpoint.endpointId;
            let correlationToken = event.directive.header.correlationToken;

            // Get current lamp state
            var state = await (hippoHttpGetRequest("/webapi/lamp/" + endpoint_id, token));
            
            if (bPower) changeStatePower(state, event.directive.header.name);
            if (bBright) changeStateBright(state, event.directive.header.name, event.payload);
            if (bColor) changeStateColor(state, event.payload);
            
            // Set lamp state
            var postPromise = hippoHttpPostRequest("/webapi/lamp/" + endpoint_id, state, token);

            // TODO: hieronder moet het nog aangepast worden

            // Construct Alexa response message
            response = handlePower(token);
            let power_state_value = "OFF";
            let hippoUrl = '/hippotronics/off.html';

            if (event.directive.header.name === "TurnOn") {
                power_state_value = "ON";
                hippoUrl = '/hippotronics/on.html';
            }


            let ar = new AlexaResponse({
                "correlationToken": correlationToken,
                "token": token,
                "endpointId": endpoint_id
            });
            ar.addContextProperty({ "namespace": "Alexa.PowerController", "name": "powerState", "value": power_state_value, "uncertaintyInMilliseconds": 1000 });
            ar.addContextProperty({ "namespace": "Alexa.EndpointHealth", "name": "connectivity", "value": { "value": "OK" }, "uncertaintyInMilliseconds": 1000 });

            response = ar.get();

            // Make sure the post request to Hippoledd succeeds before returning
            await(postPromise);
        }

    } catch (err)
    {
        console.log("Error processing directive", namespace, err);
    }
}

function changeStatePower(state, onoff)
{
    
}

async function handleDiscovery(token)
{
    let adr = new AlexaResponse({ "namespace": "Alexa.Discovery", "name": "Discover.AddOrUpdateReport" }); //Response" });
    adr.event.payload.scope = {
        type: "BearerToken",
        token: token
    };
    let capability_alexa = adr.createPayloadEndpointCapability();

    // Get information from Hippotronics service
    var response = await hippoHttpGetRequest("/webapi/lamps");
    console.log("Hippo discovery lamp status: ");
    console.log(response);

    response.forEach(function (lamp) 
    {
        // All endpoints support power and connectivity
        let capability_alexa_powercontroller = adr.createPayloadEndpointCapability({ "interface": "Alexa.PowerController", "supported": [{ "name": "powerState" }], "proactivelyReported": true });
        let capability_alexa_reporting = adr.createPayloadEndpointCapability({ "interface": "Alexa.EndpointHealth", "supported": [{ "name": "connectivity" }], "proactivelyReported": true });

        let capabilities = [capability_alexa_powercontroller, capability_alexa_reporting];

        // Endpoints 0 and 1 support brightness control
        if (lamp.NodeType < 2) {
            let capability_alexa_brightness = adr.createPayloadEndpointCapability({ "interface": "Alexa.BrightnessController", "supported": [{ "name": "brightness" }], "proactivelyReported": true });

            capabilities.push(capability_alexa_brightness);
        }

        // Endpoint type 0 supports color 
        if (lamp.NodeType == 0) {
            let capability_alexa_color = adr.createPayloadEndpointCapability({ "interface": "Alexa.ColorController", "supported": [{ "name": "color" }], "proactivelyReported": true });

            capabilities.push(capability_alexa_color);
        }

        // Description from type 
        let description = "Lamp";
        if (lamp.NodeType == 1) description += " with brightness control";
        else if (lamp.NodeType == 0) description += " with color and brightness control";


        adr.addPayloadEndpoint({ "friendlyName": lamp.Name, "endpointId": lamp.Name, "manufacturerName": "HippoTronics", "description": description, "capabilities": capabilities });
    });

    // Send async response to Alexa
    await sendResponse(adr.get(), token);
}



async function hippoHttpGetRequest(url)
{
    console.log("Executing HTTP get to", url);

    return new Promise((resolve, reject) => {
        var options = {
            host: HIPPO_HOST,
            port: HIPPO_PORT,
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
            host: HIPPO_HOST,
            port: HIPPO_PORT,
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

async function alexaPostRequest(body, token)
{
    console.log("Sending POST to Alexa ----");
    var bodyTxt = JSON.stringify(body);
    console.log(bodyTxt);
    
    return new Promise( (resolve, reject) =>
    {
        var options = {
            host: ALEXA_HOST,
            path: ALEXA_URL,
            method: 'POST',
            headers: {
                "Authorization": "Bearer " + token,
                "Content-Type": "application/json",
                "Content-Length": bodyTxt.length
            }
        };
    
        var req = https.request(options, (res) => {
            console.log("Alexa responds ", res.statusCode);

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


async function sendResponse(response, token)
{
    await alexaPostRequest(response, token);
}

