// -*- coding: utf-8 -*-

// Hippotronics Alexa Smart Home skill for Thermostat service (hippothermd).

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

    console.log("HippoThermo lambda running on port", port);
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
        // TODO: thermo implementation
        var bThermo = ns === 'alexa.thermostatcontroller';
        if (bThermo) return await handleStateChange(ns, event);

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

    // Get current thermostat state
    var state = await hippoHttpGetRequest("/webapi/state/");

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

function setEndpointStateInAlexaResponse(ar, state)
{
    // Thermo implementation
    ar.addContextProperty({ 
        "namespace": "Alexa.ThermostatController", 
        "name": "thermostatMode", 
        "value": state.HeatingOn ? "HEAT" : "ECO",
        "uncertaintyInMilliseconds": 1000 }
        );
    ar.addContextProperty({ 
        "namespace": "Alexa.ThermostatController", 
        "name": "targetSetpoint", 
        "value": state.TargetTemperature,
        "uncertaintyInMilliseconds": 1000 }
        );
    ar.addContextProperty({ 
        "namespace": "Alexa.TemperatureSensor", 
        "name": "temperature", 
        "value": state.RoomTemperature,
        "uncertaintyInMilliseconds": 1000 }
        );
    
    
    ar.addContextProperty({ 
        "namespace": "Alexa.EndpointHealth", 
        "name": "connectivity", 
        "value": { 
            "value": true /* TODO */ ? "OK" : "UNREACHABLE" }, 
            "uncertaintyInMilliseconds": 1000 }
            );
}


async function handleStateChange(ns, event)
{
    let token = event.directive.endpoint.scope.token;
    let endpoint_id = event.directive.endpoint.endpointId;
    let correlationToken = event.directive.header.correlationToken;
    let directive = event.directive.header.name.toLowerCase();

    // Thermo implementation
    if (directive == "settargettemperature")
    {
        // Obtain new target temperature
        var tNewTemp = event.directive.payload.targetSetpoint;

        // Send new temperature
        await hippoHttpPostRequest("/webapi/targettemp", tNewTemp);
    }
    else if (directive == "adjusttargettemperature")
    {
        // Obtain new target temperature
        var tNewTemp = event.directive.payload.targetSetpointDelta;

        // Send new temperature
        await hippoHttpPostRequest("/webapi/tempdelta", tNewTemp);
    }


    let ar = new AlexaResponse({
        "correlationToken": correlationToken,
        "token": token,
        "endpointId": endpoint_id
    });

    // Write the new thermostat state into the Alexa response
    var state = await hippoHttpGetRequest("/webapi/state/");
    setEndpointStateInAlexaResponse(ar, state);

    // Return Alexa response
    return ar.get();
}



async function handleDiscovery()
{
    let adr = new AlexaResponse({ "namespace": "Alexa.Discovery", "name": "Discover.Response" });
    let capability_alexa = adr.createPayloadEndpointCapability();

    let capability_alexa_thermocontroller = 
        adr.createPayloadEndpointCapability({ 
            "interface": "Alexa.ThermostatController", 
            "supported": [{ "name": "targetSetpoint" }, { "name": "thermostatMode" }], 
            "proactivelyReported": false, 
            "retrievable": true });
    
    capability_alexa_thermocontroller['configuration'] =
            { "supportedModes" : [ "OFF", "HEAT"],
              "supportsScheduling": false
            };

    let capability_alexa_thermosensor = 
            adr.createPayloadEndpointCapability({ 
                "interface": "Alexa.TemperatureSensor", 
                "supported": [{ "name": "temperature" }], 
                "proactivelyReported": false, 
                "retrievable": true });
        
    
    let capabilities = [ capability_alexa_thermocontroller, capability_alexa_thermosensor ];

    adr.addPayloadEndpoint({ 
        "friendlyName": "Hippotronics thermostat", 
        "endpointId": "Thermo", 
        "manufacturerName": "HippoTronics", 
        "description": "The only thermostat in the house", 
        "capabilities": capabilities, 
        "displayCategories": ["THERMOSTAT", "TEMPERATURE_SENSOR"] 
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



