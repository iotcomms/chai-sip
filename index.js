"use strict";
var sip = require("sip");
var digest = require("sip/digest");
var crypto = require("crypto");
var ip = require("ip");
var transform = require("sdp-transform");
var fs = require("fs");
var l = require("winston");
var util = require("util");
const { execFile } = require("child_process");
var mediatool;

var mediaProcesses = {};


if (process.env.LOG_LEVEL) {
  l.level = process.env.LOG_LEVEL;
} else {
  l.level = "warn";
}
function clone(obj) {
  if (null == obj || "object" != typeof obj) {
    return obj;
  }
  var copy = obj.constructor();
  for (var attr in obj) {
    if (obj.hasOwnProperty(attr)) {
      copy[attr] = obj[attr];
    }
  }
  return copy;
}

function rstring() { return Math.floor(Math.random() * 1e6).toString(); }

if (process.env.useMediatool) {
  var Mediatool = require("mediatool");
  if (!mediatool) {
    mediatool = new Mediatool({rtpStart:30000,rtpEnd:31000});
    mediatool.on("serverStarted", () => {
      l.verbose("mediatool started");
    });



    mediatool.start();
    l.verbose("chai-sip started mediatool");
  }
}
// Warning! This line has to be in this spot after the
// mediatool require since it otherwise might
// interact with a identical code line in mediatool.

global.__basedir = __dirname;

/// end warning


function createHash(request) {
  let stringToHash = request.headers.from.uri+":"+request.headers.to.uri+":"+request.headers.cseq.seq;
  return crypto.createHash("md5").update(stringToHash).digest("hex");
}

module.exports = function (chai, utils, sipStack) {

  var assert = chai.assert;
  if (!sipStack) {
    sip = require("sip");
  } else {
    sip = sipStack;
  }

  utils.addMethod(chai.Assertion.prototype, "status", function (code) {
    var obj = utils.flag(this, "object");
    this.assert(
      obj.status == code
      , "expected SIP  response to have status code #{exp} but got #{act}"
      , "expected SIP  response to not have status code #{act}"
      , code        // expected
      , obj.status  // actual
    );
    return;
  });


  assert.status = function (val, exp) {
    new chai.Assertion(val).to.be.status(exp);
  };

  utils.addMethod(chai.Assertion.prototype, "method", function (method) {

    var obj = utils.flag(this, "object");

    this.assert(
      obj.method == method
      , "expected SIP method to be #{exp} but got #{act}"
      , "expected SIP methid to not be #{act}"
      , method        // expected
      , obj.method  // actual
    );
    //new Assertion(obj.status).to.equal(code);

    return;
    //new chai.Assertion(obj.status).to.be.equal(code);
  });

  assert.method = function (val, exp) {
    new chai.Assertion(val).to.be.method(exp);
  };

  chai.terminateMediatool = function () {
    if (mediatool) {
      mediatool.stop(0);
    }
    if (mediaProcesses) {
      for (let dialogId in mediaProcesses) {
        if (Array.isArray(mediaProcesses[dialogId])) {
          mediaProcesses[dialogId].forEach(function (mediaProcess) {
            try {
              process.kill(mediaProcess.pid);
            } catch(e) {
              l.warn("Could not kill mediaProcess.pid",mediaProcess.pid);
            }
          });
        }
      }
    }
  };



  chai.sip = function (params) {
    var mySip;
    var requestCallback;
    var ackCallback;
    var dialogs = {};
    var request;
    var playing = {};

    var prompt0 = __basedir + "/caller.wav";
    var prompt1 = __basedir + "/callee.wav";

    var mediaclient = {};
    var currentMediaclient;
    var lastMediaId;
    var remoteUri;
    var sessionExpires;
    var reInviteDisabled;
    var refresherDisabled;
    var refreshUsingUpdate;
    var updateRefreshBody;
    var onRefreshFinalResponse;
    var lateOffer;
    var dropAck;
    var ackDelay=0;
    var useTelUri=false;
    var expirationTimers = {};
    var sipParams = {};
    var disabledMediaUsers = [];
    var dtmfCallback = params.dtmfCallback;
    var requestReady = false;
    var sipTransactionLog = {};
    var sipTransactionIndex = 0;
    sipParams = params;
    sipParams.logger = {
      send: function (message) { l.debug("SND\n" + util.inspect(message, false, null)); },
      recv: function (message) { l.debug("RCV\n" + util.inspect(message, false, null)); },
      error: function (message) { l.error("ERR\n" + util.inspect(message, false, null)); }
    };

    function handleTraceLogging (msg) {
      var wrappedRequestObj;
      let ts = Date.now();
      var hash = createHash(msg);
      if (msg.headers["content-type"] == "application/sdp") {
        msg.content = transform.parse(msg.content);
      }
      if (!sipTransactionLog["transactionId_"+hash]) {
        wrappedRequestObj =  { index: sipTransactionIndex, timeStamp: ts,  transactionId: hash, request: [], provResp:[], finalResp:[], ack:[]};
        sipTransactionLog["transactionId_"+hash] = wrappedRequestObj;
        sipTransactionLog["timestamp_"+ts] = wrappedRequestObj;
        sipTransactionLog["index_"+ sipTransactionIndex] = wrappedRequestObj;  
        sipTransactionIndex++;       
      } else {
        wrappedRequestObj = sipTransactionLog["transactionId_"+hash];
      }

      if (msg.method) {
        if (msg.method === "ACK") {
          wrappedRequestObj.ack.push(msg);
        } else {
          wrappedRequestObj.request.push(msg);
        }
      } else {
        // handle responses
        if (msg.status < 200) {
          // provsional responses
          wrappedRequestObj.provResp.push(msg);
        } else {
          // final responses
          wrappedRequestObj.finalResp.push(msg);
        }
      }
    }

    function wrappedSipSend (messageOut, callback) {  
      handleTraceLogging (clone(messageOut)); 
      mySip.send(messageOut, function (messageIn) {
        handleTraceLogging(clone(messageIn));
        if (callback) {
          callback(messageIn);
        }
      });
    }


    function stopMedia(id) {
      l.verbose("stopMedia called, id", id);

      if (process.env.useMediatool) {
        if (mediaclient[id]) {
          mediaclient[id].stop();
          delete mediaclient[id];
          return;
        }
      }
      if(mediaProcesses[id]) {
        for(var pid of mediaProcesses[id]) {
          try{
            l.verbose("Stopping mediaprocess... " + pid.pid);
            process.kill(pid.pid);
          } catch(err) {
            if(!err.code=="ESRCH") {
              l.verbose("Error killing process",JSON.stringify(err));
            }
          }
        }
        delete mediaProcesses[id];
        return;
      }
      l.warn("No matching mediaclient for " + id);
    }

    function getGstStrFromSdpMedia(dialogId, sdpMedia, ip, prompt) {
      const encrypter = ["RTP/SAVP", "RTP/SAVPF"].includes(sdpMedia.protocol) && sdpMedia.crypto.length > 0
          ? `! srtpenc key="${sdpMedia.crypto[0].config.split("|")[0].slice(7)}" `
          : "";
      let gstStr;
      for (const rtpPayload of sdpMedia.rtp) {
        if (rtpPayload.codec.toUpperCase() === "PCMA") {
          gstStr = `-m multifilesrc name=${dialogId} location=${prompt} do-timestamp=true loop=1 ! wavparse ignore-length=1 ! audioresample ! audioconvert ! capsfilter caps="audio/x-raw,format=(string)S16LE,rate=(int)8000,channel-mask=(bitmask)0x0000000000000000,channels=(int)1,layout=(string)interleaved" ! alawenc ! rtppcmapay min-ptime=20000000 max-ptime=20000000 ptime-multiple=20000000 ! capsfilter caps="application/x-rtp,media=(string)audio,maxptime=(uint)20,encoding-name=(string)PCMA,payload=(int)8,clock-rate=(int)8000" ${encrypter}! udpsink host=${ip} port=${sdpMedia.port}`;
          l.debug("Will send PCMA codec");
          break;
        }
        else if (rtpPayload.codec.toUpperCase() === "PCMU") {
          gstStr = `-m multifilesrc name=${dialogId} location=${prompt} loop=1 ! wavparse ignore-length=1 ! audioresample ! audioconvert ! capsfilter caps="audio/x-raw,format=(string)S16LE,rate=(int)8000,channel-mask=(bitmask)0x0000000000000000,channels=(int)1,layout=(string)interleaved" ! mulawenc ! rtppcmupay min-ptime=20000000 max-ptime=20000000 ! capsfilter caps="application/x-rtp,media=(string)audio,maxptime=(uint)20,encoding-name=(string)PCMU,payload=(int)0,clock-rate=(int)8000" ${encrypter}! udpsink host=${ip} port=${sdpMedia.port}`;
          l.debug("Will send PCMU codec");
          break;
        }
        else if (rtpPayload.codec.toUpperCase() === "G722") {
          gstStr = `-m multifilesrc name=${dialogId} location=${prompt} loop=1 ! wavparse ignore-length=1 ! audioresample ! audioconvert ! avenc_g722 name=rtpenc ! rtpg722pay name=rtppay min-ptime=20000000 max-ptime=20000000 ptime-multiple=20000000 ! capsfilter name=rtpcaps caps="application/x-rtp,media=(string)audio,encoding-name=(string)G722,payload=(int)9,clock-rate=(int)8000" ${encrypter}! udpsink host=${ip} port=${sdpMedia.port}`;
          l.debug("Will send G722 codec");
          break;
        }
        else if (rtpPayload.codec.toUpperCase() === "OPUS") {
          gstStr = `-m multifilesrc name=${dialogId} location=${prompt} loop=1 ! wavparse ignore-length=1 ! audioresample ! audioconvert ! capsfilter caps="audio/x-raw,format=(string)S16LE,rate=(int)8000,channel-mask=(bitmask)0x0000000000000000,channels=(int)1,layout=(string)interleaved" ! opusenc ! rtpopuspay pt=${rtpPayload.payload} min-ptime=20000000 max-ptime=20000000 ${encrypter}! udpsink host=${ip} port=${sdpMedia.port}`;
          l.debug("Will send OPUS codec");
          break;
        }
      }
      return gstStr;
    }

    function playGstMedia(dialogId, sdpMedia, sdpOrigin, prompt) {

      l.verbose("media: play GST RTP audio for", JSON.stringify(sdpMedia, null, 2));

      const ip = sdpMedia.connection?.ip ?? sdpOrigin;
      const gstStr = getGstStrFromSdpMedia(dialogId, sdpMedia, ip, prompt);

      l.debug("Will send media to " + ip + ":" + sdpMedia.port);
      const gstArr = gstStr.split(" ");

      l.debug("gstArr", JSON.stringify(gstArr));
      const pid = execFile("gst-launch-1.0", gstArr, (err) => {

        if (err) {
          if (err.signal != "SIGTERM") {
            l.error("Could not execute gst-launch-1.0", JSON.stringify(err), null, 2);
          }
          return;
        }
        l.debug("Completed gst-launch-1.0");

      });
      l.verbose("RTP audio playing, pid ", dialogId);
      if (!mediaProcesses[dialogId]) {
        mediaProcesses[dialogId] = [];
      }
      if (!pid) {
        throw "Could not start gst-launch-1.0";
      } else {
        mediaProcesses[dialogId].push(pid);
        lastMediaId = dialogId;
      }
    }

    function setDtmfPt(pt,dialogId) {

      let client;
      l.verbose("setDtmfPt",dialogId)
      if(dialogId) {
        client = mediaclient[dialogId];
      } else if (currentMediaclient) {
        l.verbose("currentMediaclient localPort",currentMediaclient.localPort)
        client = currentMediaclient;

      }
      if(client) {
        client.setDtmfPt(pt);
      } else {
        l.error("chai-sip is not configured with mediatool media component. setDtmfPt is not implemented without it.");
      }

    }

    function sendDTMF(digit,duration=80.0,dialogId) {
      let client;
      if(dialogId) {
        client = mediaclient[dialogId];
      } else if (currentMediaclient) {
        l.verbose("currentMediaclient localPort",currentMediaclient.localPort)
        client = currentMediaclient;

      }
      if(client) {
        client.sendDTMF(digit,duration);
      } else {
        l.error("chai-sip is not configured with mediatool media component. This is not implemented without it.");
      }
    }

    function getGstStrFromSdpMediaPcap(dialogId, sdpMedia, ip, pcapFile) {
      let gstStr;
      const encrypter = ["RTP/SAVP", "RTP/SAVPF"].includes(sdpMedia.protocol) && sdpMedia.crypto.length > 0
          ? `! srtpenc key="${sdpMedia.crypto[0].config.split("|")[0].slice(7)}" `
          : "";
      for (const rtpPayload of sdpMedia.rtp) {
        if (rtpPayload.codec.toUpperCase() === "PCMA") {
          gstStr = `filesrc name=${dialogId} location=${pcapFile} ! pcapparse ! capsfilter caps="application/x-rtp,media=(string)audio,encoding-name=(string)PCMA,payload=(int)8,clock-rate=(int)8000" ${encrypter}! udpsink host=${ip} port=${sdpMedia.port}`;
          l.debug("Will send PCMA codec");
          break;
        }
        else if (rtpPayload.codec.toUpperCase() === "PCMU") {
          gstStr = `filesrc name=${dialogId} location=${pcapFile} ! pcapparse ! capsfilter caps="application/x-rtp,media=(string)audio,encoding-name=(string)PCMU,payload=(int)0,clock-rate=(int)8000" ${encrypter}! udpsink host=${ip} port=${sdpMedia.port}`;
          l.debug("Will send PCMU codec");
          break;
        }
        else if (rtpPayload.codec.toUpperCase() === "G722") {
          gstStr = `filesrc name=${dialogId} location=${pcapFile} ! pcapparse ! capsfilter caps="application/x-rtp,media=(string)audio,encoding-name=(string)G722,payload=(int)9,clock-rate=(int)8000" ${encrypter}! udpsink host=${ip} port=${sdpMedia.port}`;
          l.debug("Will send G722 codec");
          break;
        }
        else if (rtpPayload.codec.toUpperCase() === "OPUS") {
          gstStr = `filesrc name=${dialogId} location=${pcapFile} ! pcapparse ! capsfilter caps="application/x-rtp,encoding-name=OPUS,payload=(int)99,media=(string)audio,clock-rate=(int)48000" ${encrypter}! udpsink host=${ip} port=${sdpMedia.port}`;
          l.debug("Will send OPUS codec");
          break;
        }
      }
      return gstStr;
    }

    function playPcapFile(dialogId, sdpMedia, sdpOrigin, pcapFile) {
      l.verbose("media: play pcapFile for", JSON.stringify(sdpMedia, null, 2));
      sipParams.pcapFile = pcapFile;

      const ip = sdpMedia.connection?.ip ?? sdpOrigin;
      l.verbose("Send pcap to ", ip, "listen on port ", sipParams.rtpPort);

      const gstStr = getGstStrFromSdpMediaPcap(dialogId, sdpMedia, ip, pcapFile);
      l.debug("Will send pcap to " + ip + ":" + sdpMedia.port);

      const gstArr = gstStr.split(" ");

      l.verbose("gstArr", JSON.stringify(gstArr));
      //var packetSize = 172;//sdp.media[0].ptime*8;
      //var pid =exec(ffmpeg.path + " -stream_loop -1 -re  -i "+ prompt +" -filter_complex 'aresample=8000,asetnsamples=n="+packetSize+"' -ac 1 -vn  -acodec pcm_alaw -f rtp rtp://" + ip + ":" + sdpMedia.port , (err, stdout, stderr) => {
      var pid = execFile("gst-launch-1.0", gstArr, (err) => {

        if (err) {
          if (err.signal != "SIGTERM") {
            l.error("Could not execute gst-launch-1.0", JSON.stringify(err), null, 2);
          }
          return;
        }
        l.debug("Completed gst-launch-1.0");

        // the *entire* stdout and stderr (buffered)
        //l.debug("gst-launch-1.0 stdout:",stdout);
        //l.debug("gst-launch-1.0 stderr:",stderr);
      });
      l.debug("RTP pcap playing, pid ");
      if (!mediaProcesses[dialogId]) {
        mediaProcesses[dialogId] = [];
      }
      if (!pid) {
        throw "Could not start gst-launch";
      } else {
        mediaProcesses[dialogId].push(pid);
        lastMediaId = dialogId;
      }

    }




    function createPipeline(dialogId) {
      return new Promise( (resolve) => {
      if (process.env.useMediatool) {

        if(mediaclient[dialogId]) {
          l.info("Mediaclient already running for dialogId",dialogId);
        }
        l.verbose("createPipeline called, using mediatool", dialogId);
        const msparams = {
          pipeline: sipParams.clientType === "webrtc" ? "webrtc" : "dtmfclient", dialogId: dialogId};
          mediatool.createPipeline(msparams, (client,localPort) => {



            client.on("pipelineStarted", () => {
              l.verbose("dtmfclient pipelineStarted");
            });

            client.on("error", (err) => {
              l.error("dtmfclient error", err);
            });


            client.on("stopped", (params) => {
              l.verbose("dtmfclient mediatool client stopped", JSON.stringify(params));
            });

            client.on("rtpTimeout", (params) => {
              l.verbose("Got rtpTimeout event for ", params, ", will stop IVR with timeoutreason");
            });


            client.on("promptPlayed", (params) => {
              l.verbose("Prompt playout complete", JSON.stringify(params));
            });

            client.on("dtmf", (args) => {
              l.verbose("mediatool dtmfclient got dtmf",args);
              if(dtmfCallback) {
                dtmfCallback(args);
              }
            });

            mediaclient[dialogId] = client;
            currentMediaclient = client;
            client.localPort = localPort;
            l.verbose("createPipeline localPort",localPort);
            resolve(localPort)
          });
        } else {
          resolve(sipParams.rtpPort)
        }
      });
    }

    function getDtmfPt(sdpMedia) {
      let dtmfPt;
      if(sdpMedia && sdpMedia.rtp && Array.isArray(sdpMedia.rtp)) {
        for(let rtp of sdpMedia.rtp) {
          if(rtp.codec=="telephone-event") {
            return rtp.payload;
          }
        }
      }
    }

    function playMedia(dialogId, sdpMedia, sdpOrigin, prompt) {


      if (process.env.useMediatool) {
        l.verbose("playMedia called, using mediatool", dialogId, prompt);

        let ip;
        if (sdpMedia.connection) {
          ip = sdpMedia.connection.ip;
        } else {
          ip = sdpOrigin;
        }

        if (ip === "0.0.0.0") {
          l.verbose("Got hold SDP, not playing media");
          resolve();
          return;
        }

        let remoteCodec = "PCMA";
        let remotePt = 8;
        if(sdpMedia.rtp && sdpMedia.rtp[0] && (sdpMedia.rtp[0].codec === "PCMU" || sdpMedia.rtp[0].codec === "G722" || sdpMedia.rtp[0].codec?.toUpperCase() === "OPUS")) {
          remoteCodec = sdpMedia.rtp[0].codec;
          remotePt = sdpMedia.rtp[0].payload;
        }

        l.debug("playMedia sdpMedia",JSON.stringify(sdpMedia,null,2));
        let remoteDtmfPt = getDtmfPt(sdpMedia);
        const msparams = {
          pipeline: sipParams.clientType === "webrtc" ? "webrtc" : "dtmfclient",
          dialogId: dialogId,
          remoteIp: ip,
          remotePort: sdpMedia.port,
          prompt: prompt,
          remoteCodec: remoteCodec,
          remotePt: remotePt,
          remoteDtmfPt:remoteDtmfPt
        };
        if(mediaclient && mediaclient[dialogId]) {
          mediaclient[dialogId].start(msparams);
        } else {
          l.info("No mediaclient found for ",dialogId);
        }
      } else {
        playGstMedia(dialogId, sdpMedia, sdpOrigin, prompt);
      }
    }

    function gotFinalResponse(response, callback) {
      l.verbose("Function gotFinalResponse");
      try {
        if (callback) {
          callback(response);
        }
      } catch (e) {
        l.error("Error", e);
        throw e;

      }
    }

    function getInviteBody(params = {}) {

      if(params.body) {
        l.verbose("getInviteBody returning passed body.",params.body)
        return params.body;
      }

      const rtpAddress = params.rtpAddress ?? sipParams.rtpAddress ?? ip.address();
      const rtpPort= params.rtpPort ?? sipParams.rtpPort ?? 30000;
      const protocol= params.protocol ?? sipParams.protocol ?? "RTP/AVP";

      let pt = 8;
      let codec = "PCMA";

      if (sipParams.codec === "PCMU" || params.codec === "PCMU") {
        pt = 0;
        codec = "PCMU";
      }
      else if (sipParams.codec === "G722" || params.codec === "G722") {
        pt = 9;
        codec = "G722";
      }
      else if (sipParams.codec === "opus" || (params.codec && params.codec.toLowerCase() === "opus")) {
        pt = 111;
        codec = "opus";
      }

      const body = [
        "v=0",
        `o=- ${rstring()} ${rstring()} IN IP4 ${rtpAddress}`,
        "s=-",
        `c=IN IP4 ${rtpAddress}`,
        "t=0 0",
        `m=audio ${rtpPort} ${protocol} ${pt} 101`,
        `a=rtpmap:${pt} ${codec}/8000`,
        "a=ptime:20",
        "a=sendrecv",
        "a=rtpmap:101 telephone-event/8000",
        "a=fmtp:101 0-15",
        "a=ptime:20",
        "a=sendrecv"
      ].join("\r\n");

      return body;
    }

    function makeRequest(method, destination, headers, contentType, body, user,params={}) {

      l.debug("makeRequest", method);

      var ipAddress;
      if (!sipParams.publicAddress) {
        ipAddress = ip.address();
      } else {
        ipAddress = sipParams.publicAddress;
      }

      let contactUser = sipParams.userid;

      if (user) {
        contactUser = user;
      }

      let contactObj = {
        uri: "sip:"+contactUser+"@" + ipAddress + ":" + (sipParams.tunnelPort || sipParams.port) + ";transport="+sipParams.transport,
        params: {}
      };



      if(params.regId && params.instanceId) {
        contactObj.params["+sip.instance"] = `"${params.instanceId}"`;
        contactObj.params["reg-id"] = params.regId;
      }

      if(params.qValue) {
        contactObj.params.q = params.qValue;
      }

      let callId = rstring() + Date.now().toString();
      if(params.callId) {
        callId = params.callId;
      }



      var req = {
        method: method,
        uri: destination,
        headers: {
          to: { uri: destination + ";transport=" + sipParams.transport },
          from: { uri: "sip:" + sipParams.userid + "@" + sipParams.domain + "", params: { tag: rstring() } },
          "call-id": callId,
          cseq: { method: method, seq: Math.floor(Math.random() * 1e5) },
          contact: [contactObj],
          //    via: createVia(),
          "max-forwards": 70

        }
      };



      if(sipParams.displayName) {
        req.headers.from.name = sipParams.displayName;
      }

      if(params.fromHeader) {
        req.headers.from = params.fromHeader;
      }
      if(params.toHeader) {
        req.headers.to = params.toHeader;
      }


      l.debug("req", JSON.stringify(req));



      if (sipParams.headers) {
        if (sipParams.headers.route) {
          l.debug("sipParams.headers.route", sipParams.headers.route);
          req.headers.route = sipParams.headers.route;
        }
      }



      if (headers) {

        req.headers = Object.assign(req.headers, headers);
      }

      if (body) {
        if (!contentType) {
          throw "Content type is missing";
        }
        req.content = body;
        req.headers["content-type"] = contentType;




      } else if (method == "INVITE" && !lateOffer) {
        req.content = getInviteBody(params);
        req.headers["content-type"] = "application/sdp";
      }

      for (var key in headers) {
        req.headers[key] = headers[key];
      }

      return req;

    }

    async function playIncomingReqMedia(rq) {
      let lp;
      if (!rq.content)
        return;
      var sdp = transform.parse(rq.content);
      if (sdp && !(sipParams.disableMedia)) {
        var id = rq.headers["call-id"];

        l.verbose("media: playIncomingReqMedia for ", rq.method, rq.uri, id,sipParams.mediaFile);
        if(process.env.useMediatool) {
          lp =  await createPipeline(id);
        }
        l.verbose("lp",lp);

        let mediaFile = prompt0;

        if(sipParams.mediaFile) {
          mediaFile = sipParams.mediaFile;
        }

        let rqUser;
        if(rq.uri) {
          rqUser = sip.parseUri(rq.uri).user
        }


        if(disabledMediaUsers.indexOf(rqUser)>=0) {
          l.verbose("Media disabled for user",rqUser,disabledMediaUsers);
          return;
        }

        if(sipParams.mediaFileConfig && sipParams.mediaFileConfig[rqUser]) {
          mediaFile = sipParams.mediaFileConfig[rqUser]
          l.verbose("Setting mediaFile from mediaFileConfig",mediaFile)
        }
        if (sdp.media[0].type == "audio") {
          if(sipParams.mediaDelay) {
            l.verbose("Will delay media playout for request")
            setTimeout(() => {
              playMedia(id, sdp.media[0], sdp.origin.address, mediaFile);
            }, sipParams.mediaDelay*1000);

          } else {
            playMedia(id, sdp.media[0], sdp.origin.address, mediaFile);
          }
        }

        if (sdp.media.length > 1) {
          if (sdp.media[1].type == "audio") {
            playMedia(id, sdp.media[1], sdp.origin.address, prompt1);

          }


        }
        return lp;

      } else {
        l.verbose("Media disabled");
      }

    }
    function sendUpdateForRequest(req, seq) {

      var ipAddress;
      if (!sipParams.publicAddress) {
        ipAddress = ip.address();
      } else {
        ipAddress = sipParams.publicAddress;
      }

      var to;
      var from;

      if (req.method) {
        to = req.headers.from;
        from = req.headers.to;
      } else {
        to = req.headers.to;
        from = req.headers.from;
      }

      let seqVal;
      if (seq) {
        seqVal = seq;
      } else {
        req.headers.cseq.seq++;
        seqVal = req.headers.cseq.seq;
      }

      var update = {
        method: "UPDATE",
        uri: req.headers.contact[0].uri,
        headers: {
          to: to,
          from: from,
          supported: "timer",
          "Session-Expires": "900;refresher=uac",
          "call-id": req.headers["call-id"],
          "Min-SE": 900,
          cseq: { method: "INVITE", seq: seqVal },
          contact: [{ uri: "sip:" + sipParams.userid + "@" + ipAddress + ":" + (sipParams.tunnelPort || sipParams.port) + ";transport=" + sipParams.transport }],
        }
      };



      if (req.headers["record-route"]) {
        update.headers["route"] = [];
        if (req.method) {
          for (let i = 0; i < req.headers["record-route"].length; i++) {
            l.debug("Push bye rr header", req.headers["record-route"][i]);
            update.headers["route"].push(req.headers["record-route"][i]);
          }
        } else {
          for (let i = req.headers["record-route"].length - 1; i >= 0; i--) {
            l.debug("Push bye rr header", req.headers["record-route"][i]);
            update.headers["route"].push(req.headers["record-route"][i]);
          }

        }

      }

      l.verbose("Send UPDATE request", JSON.stringify(update, null, 2));

      //var id = [req.headers["call-id"]].join(":");


      request = update;



      wrappedSipSend(update, (rs) => {
        l.verbose("Received UPDATE response", JSON.stringify(rs, null, 2));
      });



      return update;

    }
    function sendReinviteForRequest(req, seq, params, callback, ackCallback) {

      let ipAddress;
      if (!sipParams.publicAddress) {
        ipAddress = ip.address();
      } else {
        ipAddress = sipParams.publicAddress;
      }

      let to;
      let from;

      if (req.method) {
        to = req.headers.from;
        from = req.headers.to;
      } else {
        to = req.headers.to;
        from = req.headers.from;
      }
      let seqVal;
      if (seq) {
        seqVal = seq;
      } else {
        req.headers.cseq.seq++;
        seqVal = req.headers.cseq.seq;
      }

      let contact = [{ uri: "sip:" + sipParams.userid + "@" + ipAddress + ":" + (sipParams.tunnelPort || sipParams.port) + ";transport=" + sipParams.transport }];

      if(params.contact) {
        contact = params.contact;
      }

      const reinvite = {
        method: "INVITE",
        uri: req.headers.contact[0].uri,
        headers: {
          to: to,
          from: from,
          "call-id": req.headers["call-id"],
          cseq: { method: "INVITE", seq: seqVal },
          contact: contact,
        }
      };

      if ((params.body || params.codec || params.rtpAddress || params.rtpPort) && params.lateOffer != true) {
        reinvite.content = getInviteBody(params);
        if (params.contentType != null) {
          reinvite.headers["content-type"] = params.contentType;
        }
        else {
          reinvite.headers["content-type"] = "application/sdp";
        }
      }


      if (req.headers["record-route"]) {
        reinvite.headers["route"] = [];
        if (req.method) {
          for (let i = 0; i < req.headers["record-route"].length; i++) {
            l.debug("Push bye rr header", req.headers["record-route"][i]);
            reinvite.headers["route"].push(req.headers["record-route"][i]);
          }
        } else {
          for (let i = req.headers["record-route"].length - 1; i >= 0; i--) {
            l.debug("Push bye rr header", req.headers["record-route"][i]);
            reinvite.headers["route"].push(req.headers["record-route"][i]);
          }

        }

      }

      l.verbose("Send reinvite request", JSON.stringify(reinvite, null, 2));

      //var id = [req.headers["call-id"]].join(":");


      request = reinvite;

      if(params.disableMedia) {
        l.verbose("Stopping media for reinvite");
        const id = req.headers["call-id"];
        stopMedia(id);

      }



      wrappedSipSend(reinvite, (rs) => {
        ackDelay = params.ackDelay || 0;
        l.verbose("Received reinvite response", JSON.stringify(rs, null, 2), "ackDelay", ackDelay);
        if (callback) {
          l.verbose("Call reInvite callback");
          callback(rs);
        }

        let lateOfferSdp = params.lateOfferSdp;

        if (params.lateOfferSdp === true) {
          lateOfferSdp = getInviteBody();
        }

        console.log("sip.send ack params", params);

        if ((params.body || params.codec || params.rtpAddress || params.rtpPort) && params.lateOffer == true) {
          lateOfferSdp = getInviteBody(params);
          console.log("lateOfferSdp", lateOfferSdp);
        }


        sendAck(rs, lateOfferSdp, ackCallback);


      });



      return reinvite;




    }
    function sendBye(req, byecallback) {
      var to;
      var from;

      if (req.method) {
        to = req.headers.from;
        from = req.headers.to;
      } else {
        to = req.headers.to;
        from = req.headers.from;
      }

      req.headers.cseq.seq++;

      var bye = {
        method: "BYE",
        uri: req.headers.contact[0].uri,
        headers: {
          to: to,
          from: from,
          "call-id": req.headers["call-id"],
          cseq: { method: "BYE", seq: req.headers.cseq.seq }
        }
      };

      //bye.headers["via"] = [req.headers.via[2]];

      if (req.headers["record-route"]) {
        bye.headers["route"] = [];
        if (req.method) {
          for (let i = 0; i < req.headers["record-route"].length; i++) {
            l.debug("Push bye rr header", req.headers["record-route"][i]);
            bye.headers["route"].push(req.headers["record-route"][i]);
          }
        } else {
          for (let i = req.headers["record-route"].length - 1; i >= 0; i--) {
            l.debug("Push bye rr header", req.headers["record-route"][i]);
            bye.headers["route"].push(req.headers["record-route"][i]);
          }

        }

      }

      l.verbose("Send BYE request", JSON.stringify(bye, null, 2));

      var id = req.headers["call-id"];


      request = bye;
      stopMedia(id);
      l.debug("after stopmedia");

      wrappedSipSend(bye, (rs) => {
        l.verbose("Received bye response", JSON.stringify(rs, null, 2));
        if (byecallback) {
          byecallback(rs);
          l.verbose("Bye response callback called");
        }
      });



      return bye;

    }

    function sendInfoInDialog(req,body,contentType, infocallback) {
      var to;
      var from;

      if (req.method) {
        to = req.headers.from;
        from = req.headers.to;
      } else {
        to = req.headers.to;
        from = req.headers.from;
      }

      req.headers.cseq.seq++;

      var info = {
        method: "INFO",
        uri: req.headers.contact[0].uri,
        headers: {
          to: to,
          from: from,
          "call-id": req.headers["call-id"],
          cseq: { method: "INFO", seq: req.headers.cseq.seq },
          "content-type":contentType
        }
      };

      info.content = body;

      //info.headers["via"] = [req.headers.via[2]];

      if (req.headers["record-route"]) {
        info.headers["route"] = [];
        if (req.method) {
          for (let i = 0; i < req.headers["record-route"].length; i++) {
            l.debug("Push info rr header", req.headers["record-route"][i]);
            info.headers["route"].push(req.headers["record-route"][i]);
          }
        } else {
          for (let i = req.headers["record-route"].length - 1; i >= 0; i--) {
            l.debug("Push info rr header", req.headers["record-route"][i]);
            info.headers["route"].push(req.headers["record-route"][i]);
          }

        }

      }

      l.verbose("Send INFO request", JSON.stringify(info, null, 2));

      var id = req.headers["call-id"];


      request = info;


      wrappedSipSend(info, (rs) => {
        l.verbose("Received info response", JSON.stringify(rs, null, 2));
        if (infocallback) {
          infocallback(rs);
          l.verbose("INFO response callback called");
        }
      });



      return info;

    }


    function sendCancel(req, callback) {
      var cancel = {
        method: "CANCEL",
        uri: request.uri,
        headers: {
          to: request.headers.to,
          via: request.headers.via,
          from: request.headers.from,
          "call-id": request.headers["call-id"],
          cseq: { method: "CANCEL", seq: request.headers.cseq.seq }

        }
      };

      if (request.headers["route"]) {
        cancel.headers["route"] = request.headers["route"];
      }

      request = cancel;

      wrappedSipSend(cancel, function (rs) {
        l.verbose("Received CANCEL response", JSON.stringify(rs, null, 2));
        if (callback) {
          callback(rs);
        }
      });
      return cancel;

    }
    function sendAck(rs, sdp, callback) {
      l.verbose("Generate ACK reply for response", rs);

      if (dropAck) {
        l.verbose("Dropping ack, dropAck is true...");
        return;
      }

      var headers = {

        to: rs.headers.to,
        from: rs.headers.from,
        "call-id": rs.headers["call-id"],
        cseq: { method: "ACK", seq: rs.headers.cseq.seq }


      };


      if(sipParams && sipParams.headers) {
        headers = {...sipParams.headers,...headers};
      }

      l.verbose("Headers", JSON.stringify(headers,null,2));

      let body;
      if (sdp) {
        body = sdp;
      } else {
        body = getInviteBody();
      }

      var ack;
      remoteUri = remoteUri || rs.headers.contact[0].uri;
      if (lateOffer || sdp)
        ack = makeRequest("ACK", remoteUri, headers, "application/sdp", body);
      else
        ack = makeRequest("ACK", remoteUri, headers, null, null);
      l.debug("ACK", ack);
      //ack.headers["via"] = rs.headers.via;

      /*if(ack.headers["via"][0].params) {
        delete ack.headers["via"][0].params.received;
      }*/

      delete ack.headers["via"];



      if (rs.headers["record-route"]) {
        ack.headers["route"] = [];
        for (var i = rs.headers["record-route"].length - 1; i >= 0; i--) {
          l.debug("Push ack header", rs.headers["record-route"][i]);
          ack.headers["route"].push(rs.headers["record-route"][i]);

        }
      }

      var ipAddress;
      if (!sipParams.publicAddress) {
        ipAddress = ip.address();
      } else {
        ipAddress = sipParams.publicAddress;
      }

      if(headers && headers.contact) {
        let uri = sip.parseUri(headers.contact);
        l.verbose("parsed contact uri",uri);
        ack.headers.contact = headers.contact;
      } else {
        ack.headers.contact = [{ uri: "sip:" + sipParams.userid + "@" + ipAddress + ":" + (sipParams.tunnelPort || sipParams.port) + ";transport=" + sipParams.transport }];
      }



      l.verbose("Send ACK reply", JSON.stringify(ack, null, 2));
      if(ackDelay) {
        l.info("Using ackDelay",ackDelay);
      }


      setTimeout(() => {
        wrappedSipSend(ack);
        if(callback) {
          callback();
        }
      },ackDelay * 1000);

    }
    function handle200(rs, disableMedia = false) {
      // yes we can get multiple 2xx response with different tags
      if (rs.headers.cseq.method != "INVITE") {
        return;
      }
      l.debug("call " + rs.headers["call-id"] + " answered with tag " + rs.headers.to.params.tag);

      request.headers.to = rs.headers.to;
      request.uri = rs.headers.contact[0].uri;

      if (rs.headers["record-route"]) {
        request.headers["route"] = [];
        for (var i = rs.headers["record-route"].length - 1; i >= 0; i--) {
          l.debug("Push invite route header", rs.headers["record-route"][i]);
          request.headers["route"].push(rs.headers["record-route"][i]);

        }
      }

      remoteUri = rs.headers.contact[0].uri;


      // sending ACK

      sendAck(rs);

      l.debug("200 resp", JSON.stringify(rs, null, 2));


      var id = rs.headers["call-id"];
      l.verbose("200 response for ", id);

      if (rs.headers["content-type"] == "application/sdp") {



        var sdp = transform.parse(rs.content);

        l.verbose("Got SDP in 200 answer", sdp);
        l.verbose("Disablemedia:", disableMedia);


        if (!(sipParams.disableMedia || disableMedia)) {

          l.verbose("media: 200 response playMedia for ", id);



          if (sipParams.pcapFile) {
            let delay = 2000;
            if(sipParams.pcapDelay) {
              delay = delay + sipParams.pcapDelay * 1000;
            }
            setTimeout(() => {
              l.verbose("Starting playPcapFile",sipParams.pcapFile);
              playPcapFile(id, sdp.media[0], sdp.origin.address, sipParams.pcapFile);
            }, delay);
            return;
          }

          if(sipParams.callerPcap || sipParams.calleePcap) {

            if (sipParams.callerPcap) {
              setTimeout(() => {
                playPcapFile(id, sdp.media[0], sdp.origin.address, sipParams.callerPcap);
              }, 2000);
            }

            if (sipParams.calleePcap) {
              setTimeout(() => {
                playPcapFile(id, sdp.media[1], sdp.origin.address, sipParams.calleePcap);
              }, 2000);
            }
            return;
          }

          if (sipParams.mediaFile) {
            l.verbose("Starting mediaFile", sipParams.mediaFile);
            prompt0 = sipParams.mediaFile;
          }

          if (sdp.media[0].type == "audio") {
            if(sipParams.mediaDelay) {
              l.verbose("Will delay media playout with ",sipParams.mediaDelay,"seconds")
              setTimeout(() => {
                playMedia(id, sdp.media[0], sdp.origin.address, prompt0);
              }, sipParams.mediaDelay * 1000);

            } else {
              playMedia(id, sdp.media[0], sdp.origin.address, prompt0);
            }
          }

          if (sdp.media.length > 1) {
            if (sdp.media[1].type == "audio") {
              playMedia(id, sdp.media[1], sdp.origin.address, prompt1);

            }


          }

        } else {
          l.verbose("Media disabled");
        }


      }


      // registring our 'dialog' which is just function to process in-dialog requests
      if (!dialogs[id]) {
        dialogs[id] = function (rq) {
          if (rq.method === "BYE") {
            l.verbose("call received bye");

            delete dialogs[id];
            delete playing[rs["call-id"]];
            stopMedia(id);

            wrappedSipSend(sip.makeResponse(rq, 200, "Ok"));
          }
          else {
            wrappedSipSend(sip.makeResponse(rq, 405, "Method not allowed"));
          }
        };
      }

    }
    function replyToDigest(request, response, callback, provisionalCallback) {
      l.verbose("replyToDigest", request.uri);

      if (sipParams.headers) {
        if (sipParams.headers.route) {
          l.debug("Update route header");
          request.headers.route = sipParams.headers.route;
        }
      }

      delete request.headers.via;



      var session = { nonce: "" };
      var creds;

      let realm;
      if(response.headers["www-authenticate"]) {
        realm = JSON.parse(response.headers["www-authenticate"][0].realm);
      } else if (response.headers["proxy-authenticate"]) {
        realm = JSON.parse(response.headers["proxy-authenticate"][0].realm);
      }
      l.debug("Response realm",realm);

      if (sipParams.authInfo) {
        let user = sip.parseUri(request.headers.from.uri).user;
        if (sipParams.authInfo[user]) {
          creds = { user: user, password: sipParams.authInfo[user], realm: realm, nonce: "", uri: "" };
        }

      } else {
        creds = { user: sipParams.userid, password: sipParams.password, realm: realm, nonce: "", uri: "" };
      }
      l.debug("creds",creds);
      digest.signRequest(session, request, response, creds);
      l.verbose("Sending request again with authorization header", JSON.stringify(request, null, 2));
      wrappedSipSend(request, function (rs) {
        l.debug("Received after sending authorized request: " + rs.status);
        if (rs.status < 200) {
          if (provisionalCallback) {
            provisionalCallback(rs);
          }
        }
        if (rs.status == 200) {
          handle200(rs);
          gotFinalResponse(rs, callback);
        } else if (rs.status > 200) {
          stopMedia(rs.headers["call-id"]);
          gotFinalResponse(rs, callback);
          //sendAck(rs);
        }
      }
      );
    }
    function startSessionRefresher(rq, callId, lastSeq) {
      l.verbose("startSessionRefresher");
      if (!reInviteDisabled) {
        expirationTimers[callId] = setTimeout(() => {
          l.verbose("lastSeq", lastSeq);
          var nextSeq = lastSeq + 1;
          l.verbose("nextSeq", nextSeq);
          let rqCopy = sip.copyMessage(rq);
          delete rqCopy.headers.via;

          if (refreshUsingUpdate) {
            rqCopy.method = "UPDATE";
            rqCopy.headers.cseq.method = "UPDATE";

            if (!updateRefreshBody) {
              delete rqCopy.content;
              delete rqCopy.headers["content-type"];
              delete rqCopy.headers["content-length"];
            }

          }
          rqCopy.headers.cseq.seq = nextSeq;
          wrappedSipSend(rqCopy, (rs) => {
            if (rs.status >= 200 && onRefreshFinalResponse) {
              onRefreshFinalResponse(rs);
            }
            if (rs.status == 200) {
              startSessionRefresher(rqCopy, callId, nextSeq);
              if (rqCopy.method == "INVITE") {
                sendAck(rs);
              }
            }
          });

        }, sessionExpires * 1000 / 2);
      }
    }

    function convertToTelUri(headerValue) {
      console.log("convertToTelUri",headerValue);
      let converted = headerValue;
      if(headerValue && headerValue.uri){
        let parsed = sip.parseUri(headerValue.uri);
        console.log("parsed tel:",parsed);
        if(parsed.schema=="sip") {
          parsed.schema="tel";
          delete parsed.host;
          parsed.params = headerValue.params;
          converted = sip.stringifyUri(parsed);


        }

      }



      return converted;
    }


    function sendRequest(rq, callback, provisionalCallback, disableMedia = false) {
 
      if (sessionExpires) {
        rq.headers["session-expires"] = sessionExpires;
        if (!refresherDisabled) {
          rq.headers["session-expires"] += ";refresher=uac";
        }
        rq.headers.supported = "timer";
      }

      if(useTelUri) {
        rq.headers.to = convertToTelUri(rq.headers.to);
        rq.headers.from = convertToTelUri(rq.headers.from);
      }

      l.verbose("Sending");
      l.verbose(JSON.stringify(rq, null, 2), "\n\n");

      wrappedSipSend(rq,
        function (rs) {
          l.verbose("Got response " + rs.status + " for callid " + rs.headers["call-id"]);

          if (rs.status < 200) {
            if (provisionalCallback) {
              l.debug("Calling provisionalCallback callback");
              provisionalCallback(rs);
            }
            return;
          }
          if (rs.status == 401 || rs.status == 407) {
            l.verbose("Received auth response");
            l.verbose(JSON.stringify(rs, null, 2));
            replyToDigest(rq, rs, callback, provisionalCallback);

            return;

          }
          if (rs.status >= 300) {
            l.verbose("call failed with status " + rs.status);
            if (rq.method == "INVITE") {
              //sendAck(rs);
            }
            stopMedia(rs.headers["call-id"]);
            gotFinalResponse(rs, callback);

            return;
          }
          else if (rs.status < 200) {
            l.verbose("call progress status " + rs.status + " " + rs.reason);
            return;
          }
          else {
            l.verbose("Got final response");
            if (sessionExpires) {
              let rqCopy = sip.copyMessage(rq);
              rqCopy.headers.cseq = rs.headers.cseq;
              rqCopy.headers.to = rs.headers.to;
              startSessionRefresher(rqCopy, rs.headers["call-id"], rs.headers.cseq.seq);
            }
            if(rs.status==200) {
              handle200(rs, disableMedia);
            }
            gotFinalResponse(rs, callback);

          }
        });

    }

    l.debug("chai-sip params", params);

    if (!sipParams.publicAddress) {
      sipParams.publicAddress = ip.address();
    }
    try {
      sip.start(sipParams, async function (rq) {
        let resend = false;
        var ts = Date.now();
        l.debug("Received request", rq);
        handleTraceLogging(clone(rq));
 


        if (rq.method == "BYE" || rq.method == "CANCEL") {
          let id = rq.headers["call-id"];
          stopMedia(id);
        }

        if (rq.method == "BYE" && expirationTimers[rq.headers["call-id"]]) {
          l.verbose("Will clear session expiration timer.");
          clearTimeout(expirationTimers[rq.headers["call-id"]]);
          delete expirationTimers[rq.headers["call-id"]];
        }


        if (rq.method == "INVITE" && rq.headers.to.params.tag) {
          l.verbose("*Got reinvite");
          let id1 = rq.headers["call-id"];
          if(rq.content) {
            stopMedia(id1);
            l.debug("after stopmedia");
          }
        }
        if (requestCallback) {
          var resp;
          try {
            if (rq.method == "ACK") {
              if (ackCallback) {
                ackCallback(rq);
              }

              if (rq.content) {
                let id1 = rq.headers["call-id"];
                stopMedia(id1);
                l.debug("after ack stopmedia");
                //playIncomingReqMedia(rq);
              }
            }

            let localPort = sipParams.rtpPort

            if (rq.content && (rq.method == "INVITE" || rq.method == "ACK") && sipParams.disableMedia != true && !(sipParams.reInvitePcapFile &&  rq.headers.to.params.tag) && !(sipParams.pcapFile &&  !rq.headers.to.params.tag) ) {




              localPort = await playIncomingReqMedia(rq);
              l.verbose("response will use localPort",localPort)
            }

            resp = requestCallback(rq,localPort);
            if (resp && resp.resendResponse) {
              resp = resp.response;
              resend = true;
            }
            l.debug("requestCallback resp", resp);
            if (rq.method == "INVITE" && !rq.headers.to.params.tag) {
              rq.headers.to.params.tag = rstring();

            }
          } catch (e) {
            l.error("Error", e);
            throw e;

          }

          if (resp == "sendNoResponse") {
            l.debug("sendNoResponse action");
            return;
          }


          if (!resp) {

            var ipAddress;
            if (!sipParams.publicAddress) {
              ipAddress = ip.address();
            } else {
              ipAddress = sipParams.publicAddress;
            }



            resp = sip.makeResponse(rq, 200, "OK");
            if (!resp.content && rq.method == "INVITE") {
              resp.content = "v=0\r\n" +
                "o=- " + rstring() + " " + rstring() + " IN IP4 " + sipParams.rtpAddress + "\r\n" +
                "s=-\r\n" +
                "c=IN IP4 " + sipParams.rtpAddress + "\r\n" +
                "t=0 0\r\n" +
                "m=audio " + localPort + " RTP/AVP 0\r\n" +
                "a=rtpmap:0 PCMU/8000\r\n" +
                "a=ptime:20\r\n" +
                "a=sendrecv\r\n";
            }
            resp.headers["content-type"] = "application/sdp";
            resp.headers["contact"] = [{ uri: "sip:" + sipParams.userid + "@" + ipAddress + ":" + (sipParams.tunnelPort || sipParams.port) + ";transport=" + sipParams.transport }];
            resp.headers["record-route"] = rq.headers["record-route"];
            remoteUri = resp.headers["contact"];


          }

          if (resp.headers.cseq.method !== "ACK") {
            setTimeout(() => {
              wrappedSipSend(resp);
            }, 500);
            if (resend) {
              setTimeout(() => {
                l.info("Resending response", resp);
                wrappedSipSend(JSON.parse(JSON.stringify(resp)));
              }, 1500);            
            }
          }


          //Media for incoming request

          return;

        }

        if (rq.headers.to.params.tag) { // check if it's an in dialog request
          var id = [rq.headers["call-id"], rq.headers.to.params.tag, rq.headers.from.params.tag].join(":");

          if (dialogs[id]) {
            dialogs[id](rq);
          }
          else {
            wrappedSipSend(sip.makeResponse(rq, 481, "Call doesn't exists"));
          }
        }
        else {
          wrappedSipSend(sip.makeResponse(rq, 405, "Method not allowed"));
        }
      });
    } catch (e) {
      console.error("SIP start error " + e);
    }
    mySip = clone(sip);
    return {

      getSipTransactionLog: function () {
        return sipTransactionLog;
      },
      
      onFinalResponse: function (callback, provisionalCallback) {
        if(requestReady) {
          requestReady=false;
          sendRequest(request, callback, provisionalCallback);
        } else {
          setTimeout(()=>{this.onFinalResponse(callback, provisionalCallback);},100);
        }

      },
      register: function (destination, user, headers, callback, provisionalCallback,params) {
        request = makeRequest("REGISTER", "sip:" + destination + ";transport=" + sipParams.transport, headers, null, null, user,params);
        let uri = "sip:" + user + "@" + destination;
        request.headers.from = { uri: uri, params: { tag: rstring() } };
        request.headers.to = { uri: uri };
        requestReady=true;
        sendRequest(request, callback, provisionalCallback);
      },
      options: function (destination, headers = null, contentType = null, body = null) {
        request = makeRequest("OPTIONS", destination, headers, contentType, body);
        requestReady=true;
        return this;
      },
      playIncomingReqMedia: function (rq) {
        playIncomingReqMedia(rq);
      },
      invite: function (destination, headers, contentType, body, params) {
        requestReady = false;
        l.info("sip invite called",process.env.useMediatool);
        /*if(!body) {
          contentType = "application/sdp";
          body = fs.readFileSync(__basedir+ "/invitebody", "utf8");
        }*/


        (async ()=>{

          if (params) {
            sessionExpires = params.expires;
            reInviteDisabled = params.reInviteDisabled;
            refresherDisabled = params.refresherDisabled;
            refreshUsingUpdate = params.refreshUsingUpdate;
            updateRefreshBody = params.updateRefreshBody;
            onRefreshFinalResponse = params.onRefreshFinalResponse;

            lateOffer = params.lateOffer;
            dropAck = params.dropAck;
            ackDelay = params.ackDelay;
            useTelUri = params.useTelUri;
          }

          const callId = rstring() + Date.now().toString();
          const reqParams = {
            callId,
            codec: params?.codec,
            protocol: params?.protocol
          };

          if(process.env.useMediatool) {
            reqParams.rtpPort = await createPipeline(callId);
          }

          l.verbose("reqParams",reqParams);

          request = makeRequest("INVITE", destination, headers, contentType, body,null,reqParams);

          requestReady = true;
        })();
        return this;
      },
      inviteSipRec: function (destination, headers, contentType, body, params = {}) {
        if (!headers) {
          headers = {};
        }

        if (params) {
          sessionExpires = params.expires;
          reInviteDisabled = params.reInviteDisabled;
          refresherDisabled = params.refresherDisabled;
          refreshUsingUpdate = params.refreshUsingUpdate;
          updateRefreshBody = params.updateRefreshBody;
          onRefreshFinalResponse = params.onRefreshFinalResponse;

          lateOffer = params.lateOffer;
          dropAck = params.dropAck;
          ackDelay = params.ackDelay;
          useTelUri = params.useTelUri;

          sipParams.callerPcap = params.callerPcap;
          sipParams.calleePcap = params.calleePcap;

          if(params.user) {
            sipParams.userid = params.user;
          }
        }




        var ipAddress;
        if (!sipParams.publicAddress) {
          ipAddress = ip.address();
        } else {
          ipAddress = sipParams.publicAddress;
        }




        headers.contact = [{ uri: "sip:" + sipParams.userid + "@" + ipAddress + ":" + (sipParams.tunnelPort || sipParams.port) + ";transport=" + sipParams.transport, params: { "+sip.src": "" } }];

        headers.require = "siprec";
        headers.accept = "application/sdp, application/rs-metadata";
        if (!body) {



          body = fs.readFileSync(__basedir + "/siprecbody", "utf8");


        }

        var ct;
        l.debug("Content type:", contentType);
        if (!contentType) {
          ct = "multipart/mixed;boundary=foobar";
        } else {
          ct = contentType;
        }

        request = makeRequest("INVITE", destination, headers, ct, body);
        requestReady=true;
        return this;
      },
      reInvite: function (contentType, body, p0, p1, callback, provisionalCallback, disableMedia = false) {
        if (p0) {
          prompt0 = p0;
        }

        if (p1) {
          prompt1 = p1;
        }

        request.headers.cseq.seq++;


        delete request.headers.via;
        if (contentType) {
          request.headers["content-type"] = contentType;
        }

        if (body) {
          request.content = body;
        }

        var id1 = request.headers["call-id"];
        l.verbose("media: Got reinvite", id1);
        stopMedia(id1);

        sendRequest(request, callback, provisionalCallback, disableMedia);


      },
      message: function (destination, headers, contentType, body, params = {}, user = undefined) {
        request = makeRequest("MESSAGE", destination, headers, contentType, body, user, params);
        requestReady=true;
        return this;
      },

      info: function (destination, headers, contentType, body) {
        request = makeRequest("INFO", destination, headers, contentType, body);
        requestReady=true;
        return this;
      },
      subscribe: function (destination, headers, contentType, body) {
        request = makeRequest("SUBSCRIBE", destination, headers, contentType, body);
        requestReady=true;
        return this;
      },
      notify: function (destination, headers, contentType, body) {
        request = makeRequest("NOTIFY", destination, headers, contentType, body);
        requestReady=true;
        return this;
      },
      waitForRequest: function (reqHandler) {
        requestCallback = reqHandler;
      },
      waitForAck: function (ackHandler) {
        ackCallback = ackHandler;
      },
      sendBye: function (req, byecallback) {
        if (byecallback) {
          l.verbose("chai-sip: sendBye, byecallback", JSON.stringify(byecallback));
        }
        sendBye(req, byecallback);

      },
      sendReinviteForRequest: function (req, seq, params, callback, ackCallback) {
        sendReinviteForRequest(req, seq, params, callback, ackCallback);
      },
      sendInfoInDialog: function (req, body,contentType, infocallback) {
        sendInfoInDialog(req,body,contentType,infocallback);
      },
      playMedia: playMedia,
      setMediaDisabled: function () {
        sipParams.disableMedia = true;
      },
      setMediaDisabledForUser: function (user) {
        disabledMediaUsers.push(user);
      },
      sendUpdateForRequest: function (req, seq) {
        sendUpdateForRequest(req, seq);
      },
      makeResponse: function (req, statusCode, reasonPhrase) {
        l.debug("makeResponse", req, statusCode, reasonPhrase);
        return sip.makeResponse(req, statusCode, reasonPhrase);
      },
      parseUri: function (uri) {
        return sip.parseUri(uri);

      },
      isMediaPlaying: function(id) {
        if(mediaclient[id]) {
          return true;
        } else {
          return false;
        }
      },
      playPcapFile: playPcapFile,
      setPcapFile: function (file,pcapDelay) {
        sipParams.pcapFile = file;
        sipParams.pcapDelay = pcapDelay;
      },
      setReInvitePcapFile: function (file) {
        sipParams.reInvitePcapFile = file;
      },
      setMediaDelay: function (delay) {
        sipParams.mediaDelay = delay;
      },
      send: function (req) {
        return wrappedSipSend(req);
      },
      sendCancel: function (req, callback) {
        request = sendCancel(req, callback);
        requestReady=true;
        return this;
      },
      lastRequest: function () {

        return request;
      },
      stopMedia: function (id) {
        l.verbose("media: stopMedia for", id);
        if (mediaclient[id]) {
          mediaclient[id].stop();
          delete mediaclient[id];
        } else {
          if (mediaProcesses[id]) {
            stopMedia(id);

          } else {
            if (lastMediaId)
              stopMedia(lastMediaId);
            else
              l.warn("Could not find process for stopMedia", id);
          }

        }

      },
      stop: function () {
        if(mediaclient) {
          let keys = Object.keys(mediaclient);
          if(keys.length>0) {
            l.warn("mediaclients still running",keys);
            for(let key of keys) {
              //mediaclient[key].stop()

            }

          }
        }




        mySip.stop();

      },
      sendDTMF: function (digit,duration=100.0,dialogId) {
        l.verbose("chai-sip sendDTMF",digit,duration);
        sendDTMF(digit,duration,dialogId);

      },

      setDtmfPt: function (pt,dialogId) {
        l.verbose("chai-sip setDtmfPt",pt);
        setDtmfPt(pt,dialogId);

      }




    };
  };

};