// -*- coding: utf-8 -*-

// Hippotronics Alexa Smart Home skill for RGB led service (hippoledd).

'use strict';

// Node 6.10 compatibility
var async = require('asyncawait/async');
var await = require('asyncawait/await');

const https = require('https');
var Promise = require('promise');
var bodyJson = require("body/json");
var Colr = require("colr");

let AlexaResponse = require("./alexa/AlexaResponse");



exports.handler = async(function(event, context) {

    // Dump the request for logging - check the CloudWatch logs
    console.log("index.handler request  ——");
    console.log(JSON.stringify(event));

    if (context !== undefined) {
        console.log("index.handler context  ——");
        console.log(JSON.stringify(context));
    }

    // Standard response if we don't know what to do
    let response = new AlexaResponse({
        "name": "ErrorResponse",
        "payload": {
            "type": "INTERNAL_ERROR",
            "message": "Unknown request"
        }
    }).get();

    // Validate we have an Alexa directive
    if (!('directive' in event)) {
        let aer = new AlexaResponse({
            "name": "ErrorResponse",
            "payload": {
                "type": "INVALID_DIRECTIVE",
                "message": "Missing key: directive, Is request a valid Alexa directive?"
            }
        });
        return sendResponse(aer.get());
    }

    // Check the payload version
    if (event.directive.header.payloadVersion !== "3") {
        let aer = new AlexaResponse({
            "name": "ErrorResponse",
            "payload": {
                "type": "INTERNAL_ERROR",
                "message": "This skill only supports Smart Home API version 3"
            }
        });
        return sendResponse(aer.get());
    }

    let namespace = ((event.directive || {}).header || {}).namespace;


    if (namespace.toLowerCase() === 'alexa.authorization') {
        let aar = new AlexaResponse({ "namespace": "Alexa.Authorization", "name": "AcceptGrant.Response", });
        return sendResponse(aar.get());
    }

    if (namespace.toLowerCase() === 'alexa.discovery') {
        let token = event.directive.payload.scope.token;
        response = await(handleDiscovery(token));
    }

    var bPower = namespace.toLowerCase() === 'alexa.powercontroller';
    var bBright = namespace.toLowerCase() === 'alexa.brightnesscontroller';
    var bColor = namespace.toLowerCase() === 'alexa.colorcontroller';
    var bStateChange = bPower || bBright || bColor;

    if (bStateChange) 
    {
        let endpoint_id = event.directive.endpoint.endpointId;
        let token = event.directive.endpoint.scope.token;
        let correlationToken = event.directive.header.correlationToken;

        // Get current lamp state
        var state = await (hippoHttpsGetRequest("/hippoledd/webapi/lamp/" + endpoint_id, token));
        
        if (bPower) changeStatePower(state, event.directive.header.name);
        if (bBright) changeStateBright(state, event.directive.header.name, event.payload);
        if (bColor) changeStateColor(state, event.payload);
        
        // Set lamp state
        var postPromise = hippoHttpsPostRequest("/hippoledd/webapi/lamp/" + endpoint_id, state, token);

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

    sendResponse(response);
});

function changeStatePower(state, onoff)
{
    
}

//function handleDiscovery(token)
var handleDiscovery = async(function (token)
{
    let adr = new AlexaResponse({ "namespace": "Alexa.Discovery", "name": "Discover.Response" });
    let capability_alexa = adr.createPayloadEndpointCapability();

    // Get information from Hippotronics service
    var response = await(hippoHttpsGetRequest("/hippoledd/webapi/lamps", token));
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

    return adr.get();
});



//function hippoHttpsGetRequest(url, token)
var hippoHttpsGetRequest = async (function (url, token)
{
    console.log("Executing HTTPS get to ", url);

    return new Promise((resolve, reject) => {
        var options = {
            host: "amsterdam.termors.net",
            path: url,
            headers: {
                "Authorization": "Bearer " + token
            }
        };

        https.get(options, (res) => {
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
});

function sendResponse(response) {
    // TODO Validate the response
    console.log("index.handler response ——");
    console.log(JSON.stringify(response));
    return response;
}

