
"use strict";
var sip = require("sip");
//  var util = require('util');
var digest = require("sip/digest");
var ip = require("ip");
var transform = require("sdp-transform");
var fs = require("fs");
var l = require("winston");
var util = require("util");

/*global __basedir*/
global.__basedir = __dirname;


if(process.env.LOG_LEVEL) {
  l.level = process.env.LOG_LEVEL;
} else {
  l.level="warn";
}



const { execFile } = require("child_process");


var dialogs = {};
var request;
var requestCallback;
var ackCallback;
var playing = {};
var mediaProcesses = {};
var prompt0 = __basedir + "/caller.wav";
var prompt1 = __basedir + "/callee.wav";
var mediatool;
var mediaclient = {};
var currentMediaclient;
var lastMediaId;
var remoteUri;





function rstring() { return Math.floor(Math.random()*1e6).toString(); }

if(process.env.useMediatool) {
  var Mediatool = require("mediatool");
  mediatool = new Mediatool();
  mediatool.on("serverStarted", () => {
    l.info("mediatool started");
  });

  mediatool.start();
  l.info("chai-sip started mediatool");

}


function sendBye(req,byecallback) {
  var ipAddress;
  if(!sipParams.publicAddress) {
    ipAddress =  ip.address();
  } else {
    ipAddress = sipParams.publicAddress;
  }

  var to;
  var from;

  if(req.method) {
    to = req.headers.from;
    from = req.headers.to;
  } else {
    to = req.headers.to;
    from = req.headers.from;
  }

  var bye = {
    method: "BYE",
    uri: req.headers.contact[0].uri,
    headers: {
      to: to,
      from: from,
      "call-id": req.headers["call-id"],
      cseq: {method: "BYE", seq: req.headers.cseq.seq++},
      contact: [{uri: "sip:"+sipParams.userid+"@" + ipAddress + ":" + sipParams.port + ";transport="+sipParams.transport  }],


    }
  };

  //bye.headers["via"] = [req.headers.via[2]];

  if(req.headers["record-route"]) {
    bye.headers["route"] = [];
    if(req.method) {
      for(let i=0;i<req.headers["record-route"].length;i++){
        l.debug("Push bye rr header",req.headers["record-route"][i]);
        bye.headers["route"].push(req.headers["record-route"][i]);
      }
    } else {
      for(let i=req.headers["record-route"].length-1;i>=0;i--){
        l.debug("Push bye rr header",req.headers["record-route"][i]);
        bye.headers["route"].push(req.headers["record-route"][i]);
      }

    }

  }

  l.verbose("Send BYE request",JSON.stringify(bye,null,2));

  var id = [req.headers["call-id"], from.params.tag, to.params.tag].join(":");


  request = bye;
  stopMedia(id);
  l.verbose("after stopmedia");

  sip.send(bye,(rs) =>  {
    l.verbose("Received bye response",JSON.stringify(rs,null,2));
    if(byecallback) {
      byecallback(rs);
      l.verbose("Bye response callback called");
    }
  });



  return bye;

}


function sendCancel(req,callback) {
  var cancel = {
    method: "CANCEL",
    uri: request.uri,
    headers: {
      to: req.headers.to,
      via: req.headers.via,
      from: req.headers.from,
      "call-id": req.headers["call-id"],
      cseq: {method: "CANCEL", seq: req.headers.cseq.seq}

    }
  };

  //bye.headers["via"] = [req.headers.via[2]];

  if(req.headers["record-route"]) {
    cancel.headers["route"] = [];
    for(var i=req.headers["record-route"].length-1;i>=0;i--){
      l.debug("Push bye rr header",req.headers["record-route"][i]);
      cancel.headers["route"].push(req.headers["record-route"][i]);

    }
  }

  l.verbose("Send CANCEL request",JSON.stringify(cancel,null,2));

  request = cancel;

  sip.send(cancel,function(rs) {
    l.verbose("Received CANCEL response",JSON.stringify(rs,null,2));
    if(callback) {
      callback(rs);
    }
  });



  return cancel;

}

function sendAck(rs) {
  l.verbose("Generate ACK reply for response",rs);
  var headers = {

    to: rs.headers.to,
    from: rs.headers.from,
    "call-id": rs.headers["call-id"],
    cseq: {method: "ACK", seq: rs.headers.cseq.seq}


  };

  l.debug("Headers",headers);




  var ack = makeRequest("ACK", remoteUri, headers, null, null);
  l.debug("ACK",ack);
  //ack.headers["via"] = rs.headers.via;

  /*if(ack.headers["via"][0].params) {
    delete ack.headers["via"][0].params.received;
  }*/

  delete ack.headers["via"] ;



  if(rs.headers["record-route"]) {
    ack.headers["route"] = [];
    for(var i=rs.headers["record-route"].length-1;i>=0;i--){
      l.debug("Push ack header",rs.headers["record-route"][i]);
      ack.headers["route"].push(rs.headers["record-route"][i]);

    }
  }

  var ipAddress;
  if(!sipParams.publicAddress) {
    ipAddress =  ip.address();
  } else {
    ipAddress = sipParams.publicAddress;
  }


  
  ack.headers.contact =  [{uri: "sip:"+sipParams.userid+"@" + ipAddress + ":" + sipParams.port + ";transport="+sipParams.transport  }],


  l.verbose("Send ACK reply",JSON.stringify(ack,null,2));


  sip.send(ack);

}

function stopMedia(id) {


  l.verbose("stopMedia called, id", id);

  if(process.env.useMediatool) {
    if(mediaclient[id]) {
      mediaclient[id].stop();
    } else {
      l.warn("No matching mediaclient, have these:",mediaclient);
    }
  

  } else {
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
    }
  }
}

function listenMedia() {


}

function playGstMedia(dialogId,sdpMedia,sdpOrigin,prompt) {

  l.debug("play RTP audio for",JSON.stringify(sdpMedia,null,2));
  var ip;
  if(sdpMedia.connection) {
    ip = sdpMedia.connection.ip;
  } else {
    ip =sdpOrigin;
  }

  var gstStr;
  for(var rtpPayload of sdpMedia.rtp) {
    if(rtpPayload.codec.toUpperCase() == "PCMA") {
      gstStr = "-m multifilesrc name="+dialogId+" location="+prompt+" loop=1 ! wavparse ignore-length=1 ! audioresample ! audioconvert ! capsfilter caps=\"audio/x-raw,format=(string)S16LE,rate=(int)8000,channel-mask=(bitmask)0x0000000000000000,channels=(int)1,layout=(string)interleaved\" ! alawenc ! rtppcmapay min-ptime=20000000 max-ptime=20000000 ! capsfilter caps=\"application/x-rtp,media=(string)audio,maxptime=(uint)20,encoding-name=(string)PCMA,payload=(int)8,clock-rate=(int)8000\" ! udpsink host="+ip+" port="+sdpMedia.port;
      l.debug("Will send PCMA codec");
      break;
    }

    if(rtpPayload.codec.toUpperCase() == "PCMU") {
      gstStr = "-m multifilesrc name="+dialogId+" location="+prompt+" loop=1 ! wavparse ignore-length=1 ! audioresample ! audioconvert !  capsfilter caps=\"audio/x-raw,format=(string)S16LE,rate=(int)8000,channel-mask=(bitmask)0x0000000000000000,channels=(int)1,layout=(string)interleaved\" ! mulawenc ! rtppcmupay min-ptime=20000000 max-ptime=20000000 ! capsfilter caps=\"application/x-rtp,media=(string)audio,maxptime=(uint)20,encoding-name=(string)PCMU,payload=(int)0,clock-rate=(int)8000\" ! udpsink host="+ip+" port="+sdpMedia.port;
      l.debug("Will send PCMU codec");
      break;
    }

    if(rtpPayload.codec.toUpperCase() == "OPUS") {
      gstStr = "-m multifilesrc name="+dialogId+" location="+prompt+" loop=1 ! wavparse ignore-length=1  ! audioresample ! audioconvert !  capsfilter caps=\"audio/x-raw,format=(string)S16LE,rate=(int)8000,channel-mask=(bitmask)0x0000000000000000,channels=(int)1,layout=(string)interleaved\" ! opusenc ! rtpopuspay pt="+rtpPayload.payload+" min-ptime=20000000 max-ptime=20000000 ! udpsink host="+ip+" port="+sdpMedia.port;
      l.debug("Will send OPUS codec");
      break;
    }

  }

  l.debug("Will send media to " + ip + ":" + sdpMedia.port);


  //opus


  var gstArr = gstStr.split(" ");

  l.verbose("gstArr", JSON.stringify(gstArr));
  //var packetSize = 172;//sdp.media[0].ptime*8;
  //var pid =exec(ffmpeg.path + " -stream_loop -1 -re  -i "+ prompt +" -filter_complex 'aresample=8000,asetnsamples=n="+packetSize+"' -ac 1 -vn  -acodec pcm_alaw -f rtp rtp://" + ip + ":" + sdpMedia.port , (err, stdout, stderr) => {
  var pid = execFile("gst-launch-1.0", gstArr, (err) => {

    if (err) {
      if(err.signal!="SIGTERM") {
        l.error("Could not execute ffmpeg",JSON.stringify(err),null,2);
      }
      return;
    }
    l.debug("Completed ffmpeg");

    // the *entire* stdout and stderr (buffered)
    //l.debug("stdout:",stdout);
    //l.debug("stderr:",stderr);
  });
  l.info("RTP audio playing, pid ",dialogId);
  if(!mediaProcesses[dialogId]) {
    mediaProcesses[dialogId] = [];
  }
  if(!pid) {
    throw "Could not start gst-launch";
  } else {
    mediaProcesses[dialogId].push(pid);
    lastMediaId = dialogId;
  }


}

function sendDTMF(digit) {
  if(currentMediaclient) {
    currentMediaclient.sendDTMF(digit);
  } else {
    l.error("chai-sip is not configured with mediatool media component. This is not implemented without it.");
  }
}

function playMedia(dialogId,sdpMedia,sdpOrigin,prompt) {
  if(process.env.useMediatool) {

    var ip;
    if(sdpMedia.connection) {
      ip = sdpMedia.connection.ip;
    } else {
      ip =sdpOrigin;
    }

    var msparams = {pipeline:"dtmfclient",dialogId: dialogId, remoteIp:ip, remotePort: sdpMedia.port, prompt:prompt};
    mediatool.createPipeline(msparams,(client) => {
   


      client.on("pipelineStarted",()=>{
        l.verbose("IVR pipelineStarted");
      });

      client.on("error",(err)=>{
        l.error("IVR error",err);
      });


      client.on("stopped",(params) => {
        l.verbose("IVR mediatool client stopped", JSON.stringify(params));
      });

      client.on("rtpTimeout", (params) =>  {
        l.verbose("Got rtpTimout event for ",params,", will stop IVR with timeoutreason");
      });


      client.on("promptPlayed",(params) => {
        l.verbose("Prompt playout complete", JSON.stringify(params));
      });

      mediaclient[dialogId] = client;
      currentMediaclient = client;

      mediaclient[dialogId].start();

    });

  
  
  
  } else {
    playGstMedia(dialogId,sdpMedia,sdpOrigin,prompt);
  }
}

function handle200(rs,disableMedia=false) {
  // yes we can get multiple 2xx response with different tags
  if(request.method!="INVITE") {
    return;
  }
  l.debug("call "+ rs.headers["call-id"] +" answered with tag " + rs.headers.to.params.tag);

  request.headers.to = rs.headers.to;
  request.uri = rs.headers.contact[0].uri;

  if(rs.headers["record-route"]) {
    request.headers["route"] = [];
    for(var i=rs.headers["record-route"].length-1;i>=0;i--){
      l.debug("Push invite route header",rs.headers["record-route"][i]);
      request.headers["route"].push(rs.headers["record-route"][i]);

    }
  }

  remoteUri = rs.headers.contact[0].uri;


  // sending ACK

  sendAck(rs);

  l.debug("200 resp",JSON.stringify(rs,null,2));

  var id = [rs.headers["call-id"], rs.headers.from.params.tag, rs.headers.to.params.tag].join(":");

  if(rs.headers["content-type"]=="application/sdp") {



    var sdp = transform.parse(rs.content);

    l.verbose("Got SDP in 200 answer",sdp);
    l.verbose("Disablemedia:",disableMedia);


    if(!(sipParams.disableMedia || disableMedia)) {


      if(sdp.media[0].type=="audio") {
        playMedia(id,sdp.media[0],sdp.origin.address,prompt0);
      }

      if(sdp.media.length>1) {
        if(sdp.media[1].type=="audio") {
          playMedia(id,sdp.media[1],sdp.origin.address,prompt1);

        }


      }

    } else {
      l.info("Media disabled");
    }


  }








  // registring our 'dialog' which is just function to process in-dialog requests
  if(!dialogs[id]) {
    dialogs[id] = function(rq) {
      if(rq.method === "BYE") {
        l.verbose("call received bye");

        delete dialogs[id];
        delete playing[rs["call-id"]];
        stopMedia(id);

        sip.send(sip.makeResponse(rq, 200, "Ok"));
      }
      else {
        sip.send(sip.makeResponse(rq, 405, "Method not allowed"));
      }
    };
  }

}

function replyToDigest(request,response,callback,provisionalCallback) {
  l.verbose("replyToDigest",request.uri);

  if(sipParams.headers) {
    if(sipParams.headers.route) {
      l.debug("Update route header");
      request.headers.route=sipParams.headers.route;
    }
  }

  delete request.headers.via;



  var session = {nonce: ""};
  var creds = {user:sipParams.userid,password:sipParams.password,realm:sipParams.domain, nonce:"",uri:""};
  digest.signRequest(session,request,response,creds);
  l.verbose("Sending request again with authorization header",JSON.stringify(request,null,2));
  sip.send(request,function(rs) {
    l.debug("Received after sending authorized request: "+rs.status);
    if(rs.status<200) {
      if(provisionalCallback) {
        provisionalCallback(rs);
      }
    }
    if(rs.status==200){
      handle200(rs);
      gotFinalResponse(rs,callback);
    } else if (rs.status>200){
      gotFinalResponse(rs,callback);
      //sendAck(rs);
    }
  }
  );
}

function gotFinalResponse(response,callback) {
  l.verbose("Function gotFinalResponse");
  try {
    if(callback) {
      callback(response);
    }
  } catch (e) {
    l.error("Error",e);
    throw e;

  }
}


function makeRequest(method, destination, headers, contentType, body) {

  l.debug("makeRequest",method);

  var ipAddress;
  if(!sipParams.publicAddress) {
    ipAddress =  ip.address();
  } else {
    ipAddress = sipParams.publicAddress;
  }

  var req = {
    method: method,
    uri: destination,
    headers: {
      to: {uri: destination + ";transport="+sipParams.transport},
      from: {uri: "sip:"+sipParams.userid+"@"+sipParams.domain+"", params: {tag: rstring()}},
      "call-id": rstring()+Date.now().toString(),
      cseq: {method: method, seq: Math.floor(Math.random() * 1e5)},
      contact: [{uri: "sip:"+sipParams.userid+"@" + ipAddress + ":" + sipParams.port + ";transport="+sipParams.transport  }],
      //    via: createVia(),
      "max-forwards" : 70

    }
  };

  l.debug("req",req);



  if(sipParams.headers) {
    if(sipParams.headers.route) {
      l.debug("sipParams.headers.route",sipParams.headers.route);
      req.headers.route=sipParams.headers.route;
    }
  }



  if(headers) {

    req.headers = Object.assign(req.headers,headers);
  }

  if(body) {
    if(!contentType) {
      throw "Content type is missing";
    }
    req.content = body;
    req.headers["content-type"] = contentType;




  } else if(method=="INVITE"){



    req.content =   "v=0\r\n"+
    "o=- "+rstring()+" "+rstring()+" IN IP4 "+sipParams.rtpAddress+"\r\n"+
    "s=-\r\n"+
    "c=IN IP4 "+sipParams.rtpAddress+"\r\n"+
    "t=0 0\r\n"+
    "m=audio "+sipParams.rtpPort+" RTP/AVP 8\r\n"+
    "a=rtpmap:0 PCMA/8000\r\n"+
    "a=ptime:20\r\n"+
    "a=sendrecv\r\n";
    req.headers["content-type"] = "application/sdp";
  }

  for(var key in headers) {
    req[key] = headers[key];
  }

  return req;

}

function playIncomingReqMedia(rq) {
  var sdp = transform.parse(rq.content);
  if(!(sipParams.disableMedia)) {
    var id = [rq.headers["call-id"], rq.headers.from.params.tag, rq.headers.to.params.tag].join(":");


    if(sdp.media[0].type=="audio") {
      playMedia(id,sdp.media[0],sdp.origin.address,prompt0);
    }

    if(sdp.media.length>1) {
      if(sdp.media[1].type=="audio") {
        playMedia(id,sdp.media[1],sdp.origin.address,prompt1);

      }


    }

  } else {
    l.info("Media disabled");
  }

}

function sendRequest(rq,callback,provisionalCallback,disableMedia=false) {
  l.verbose("Sending");
  l.verbose(JSON.stringify(rq,null,2),"\n\n");
  sip.send(rq,
    function(rs) {

      l.verbose("Got response " + rs.status + " for callid "+ rs.headers["call-id"]);

      if(rs.status<200) {
        if(provisionalCallback) {
          l.debug("Calling provisionalCallback callback");
          provisionalCallback(rs);
        }
        return;
      }

      if(rs.status==401 || rs.status==407) {
        l.verbose("Received auth response");
        l.verbose(JSON.stringify(rs,null,2));
        replyToDigest(rq,rs,callback,provisionalCallback);

        return;

      }
      if(rs.status >= 300) {
        l.verbose("call failed with status " + rs.status);
        if(rq.method=="INVITE") {
          //sendAck(rs);
        }
        gotFinalResponse(rs,callback);

        return;
      }
      else if(rs.status < 200) {
        l.verbose("call progress status " + rs.status + " " + rs.reason);
        return;
      }
      else {
        l.verbose("Got final response");

        handle200(rs,disableMedia);
        gotFinalResponse(rs,callback);

      }
    });

}







var sipParams = {};





module.exports = function (chai, utils) {

  var  assert = chai.assert;


  utils.addMethod(chai.Assertion.prototype, "status", function (code) {
    var obj = utils.flag(this, "object");
    this.assert(
      obj.status == code
      , "expected SIP  response to have status code #{exp} but got #{act}"
      , "expected SIP  response to not have status code #{act}"
      , code        // expected
      , obj.status  // actual
    );
    //new Assertion(obj.status).to.equal(code);

    return;
    //new chai.Assertion(obj.status).to.be.equal(code);
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

  chai.terminateMediatool = function() {
    if(mediatool) {
      mediatool.stop();
    }
  };




  chai.sip = function (params){

    sipParams = params;
    sipParams.logger = {
      send: function(message) { l.debug("SND\n" + util.inspect(message, false, null)); },
      recv: function(message) { l.debug("RCV\n" + util.inspect(message, false, null)); },
      error: function(message) { l.error("ERR\n" + util.inspect(message, false, null)); }
    };
    l.verbose("chai-sip params",params);

    if(!sipParams.publicAddress) {
      sipParams.publicAddress = ip.address();
    }


    try {
      sip.start(sipParams, function(rq) {
        l.debug("Received request",rq);
        if(requestCallback) {
          var resp;
          try {
            if(rq.method=="ACK") {
              if(ackCallback) {
                ackCallback(rq);
              }

              if(rq.content) {
                playIncomingReqMedia(rq);
              }
            }

            
            resp = requestCallback(rq);
            if(rq.method=="INVITE") {
              rq.headers.to.params.tag = rstring();
             
            }
          } catch (e) {
            l.error("Error",e);
            throw e;

          }

          if(resp=="sendNoResponse") {
            return;
          }


          if(!resp) {

            var ipAddress;
            if(!sipParams.publicAddress) {
              ipAddress =  ip.address();
            } else {
              ipAddress = sipParams.publicAddress;
            }

            resp = sip.makeResponse(rq,200,"OK");
            resp.content =   "v=0\r\n"+
            "o=- "+rstring()+" "+rstring()+" IN IP4 "+sipParams.rtpAddress+"\r\n"+
            "s=-\r\n"+
            "c=IN IP4 "+sipParams.rtpAddress+"\r\n"+
            "t=0 0\r\n"+
            "m=audio "+sipParams.rtpPort+" RTP/AVP 0\r\n"+
            "a=rtpmap:0 PCMU/8000\r\n"+
            "a=ptime:20\r\n"+
            "a=sendrecv\r\n";
            resp.headers["content-type"] = "application/sdp";
            resp.headers["contact"] = [{uri: "sip:"+sipParams.userid+"@" + ipAddress  + ":"+sipParams.port+";transport="+sipParams.transport}];
            resp.headers["record-route"] = rq.headers["record-route"];
            remoteUri = resp.headers["contact"];


          }
          
          sip.send(resp);

          //Media for incoming request
          if(rq.content && resp.status==200) {
            playIncomingReqMedia(rq);
          }
          return;

        }

        if(rq.headers.to.params.tag) { // check if it's an in dialog request
          var id = [rq.headers["call-id"], rq.headers.to.params.tag, rq.headers.from.params.tag].join(":");

          if(dialogs[id])
            dialogs[id](rq);
          else
            sip.send(sip.makeResponse(rq, 481, "Call doesn't exists"));
        }
        else
          sip.send(sip.makeResponse(rq, 405, "Method not allowed"));
      });
    } catch (e) {
      console.error("SIP start error " + e);
    }

    return {




      onFinalResponse : function(callback,provisionalCallback) {
        sendRequest(request,callback,provisionalCallback);

      },
      register : function(destination,user,headers,callback,provisionalCallback) {
        request = makeRequest("REGISTER","sip:"+destination+";transport="+sipParams.transport,headers,null,null);
        let uri = "sip:"+user+"@"+destination;
        request.headers.from= {uri:uri,params:{tag:rstring()}};
        request.headers.to= {uri:uri};
        sendRequest(request,callback,provisionalCallback);
      },


      options : function(destination,headers=null,contentType=null,body=null) {
        request = makeRequest("OPTIONS",destination,headers,contentType,body);
        return this;
      },

      playIncomingReqMedia : function(rq) {
        playIncomingReqMedia(rq);
      },

      invite : function(destination,headers,contentType,body) {
        /*if(!body) {
          contentType = "application/sdp";
          body = fs.readFileSync(__basedir+ "/invitebody", "utf8");
        }*/
        request = makeRequest("INVITE",destination,headers,contentType,body);
        if(sipParams.playRtp) {
          listenMedia();
        }
        return this;
      },


      inviteSipRec : function(destination,headers,contentType,body) {
        if(!headers) {
          headers = {};
        }

        var ipAddress;
        if(!sipParams.publicAddress) {
          ipAddress =  ip.address();
        } else {
          ipAddress = sipParams.publicAddress;
        }

       


        headers.contact = [{uri: "sip:"+sipParams.userid+"@" + ipAddress  + ":"+sipParams.port+";transport="+sipParams.transport,  params: {"+sip.src":""}}];

        headers.require = "siprec";
        headers.accept = "application/sdp, application/rs-metadata";
        if(!body) {



          body = fs.readFileSync(__basedir+"/siprecbody", "utf8");


        }

        var ct;
        l.debug("Content type:",contentType);
        if(!contentType) {
          ct="multipart/mixed;boundary=foobar";
        } else {
          ct=contentType;
        }

        request = makeRequest("INVITE",destination,headers,ct,body);
        return this;
      },
      reInvite : function (contentType,body,p0,p1,callback,provisionalCallback,disableMedia=false) {
        if(p0) {
          prompt0=p0;
        }

        if(p1) {
          prompt1=p1;
        }

        request.headers.cseq.seq++;

        delete request.headers.via;
        if(contentType) {
          request.headers["content-type"] = contentType;
        }

        if(body) {
          request.content = body;
        }
       
        var id1 = [request.headers["call-id"], request.headers.from.params.tag, request.headers.to.params.tag].join(":");
        stopMedia(id1);

        sendRequest(request,callback,provisionalCallback,disableMedia);


      },

      message : function(destination,headers,contentType,body) {
        request = makeRequest("MESSAGE",destination,headers,contentType,body);
        return this;
      },
      waitForRequest : function(reqHandler) {
        requestCallback = reqHandler;
      },

      waitForAck : function(ackHandler) {
        ackCallback = ackHandler;
      },


      sendBye : function(req,byecallback) {
        if(byecallback) {
          l.verbose("chai-sip: sendBye, byecallback",JSON.stringify(byecallback));
        }
        sendBye(req,byecallback);

      },

      makeResponse : function(req,statusCode,reasonPhrase) {
        return sip.makeResponse(req, statusCode, reasonPhrase);
      },

      parseUri : function(uri) {
        return sip.parseUri(uri);

      },

      send: function(req) {
        return sip.send(req);
      },



      sendCancel : function(req,callback) {
        request = sendCancel(req,callback);
        return this;
      },

      lastRequest : function() {

        return request;
      },

      stopMedia : function(id) {
        if(mediaclient[id]) {
          mediaclient[id].stop();
        } else {
          if(mediaProcesses[id]) {
            stopMedia(id);

          } else {
            if(lastMediaId)
              stopMedia(lastMediaId);
            else 
              l.warn("Could not find process for stopMedia",id);
          }
          
        }

      },

  

      stop : function() {
        /*if(mediaclient) {
          mediaclient.stop();
        }*/

        sip.stop();

      },

   

      sendDTMF : function(digit) {
        sendDTMF(digit);

      }

    };





  };




};
