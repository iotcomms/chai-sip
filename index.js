
"use strict";
var sip = require("sip");
//  var util = require('util');
var digest = require("sip/digest");
var ip = require("ip");
var transform = require("sdp-transform");
var fs = require("fs");
var ffmpeg = require("@ffmpeg-installer/ffmpeg");
var l = require("winston");
/*global __basedir*/
global.__basedir = __dirname;


if(process.env.LOG_LEVEL) {
  l.level = process.env.LOG_LEVEL;
} else {
  l.level="warn";
}



const { exec } = require("child_process");


var dialogs = {};
var request;
var requestCallback;
var playing = {};


function rstring() { return Math.floor(Math.random()*1e6).toString(); }


function sendBye(req) {
  var bye = {
    method: "BYE",
    uri: req.headers.contact[0].uri,
    headers: {
      to: req.headers.to,
      from: req.headers.from,
      "call-id": req.headers["call-id"],
      cseq: {method: "BYE", seq: req.headers.cseq.seq}

    }
  };

  //bye.headers["via"] = [req.headers.via[2]];

  if(req.headers["record-route"]) {
    bye.headers["route"] = [];
    for(var i=req.headers["record-route"].length-1;i>=0;i--){
      l.debug("Push bye rr header",req.headers["record-route"][i]);
      bye.headers["route"].push(req.headers["record-route"][i]);

    }
  }

  l.verbose("Send BYE request",JSON.stringify(bye,null,2));

  request = bye;

  sip.send(bye,function(rs) {
    l.verbose("Received bye response",JSON.stringify(rs,null,2));
  });



  return bye;

}

function handle200(rs) {
  // yes we can get multiple 2xx response with different tags
  if(request.method!="INVITE") {
    return;
  }
  l.debug("call "+ rs.headers["call-id"] +" answered with tag " + rs.headers.to.params.tag);

  // sending ACK

  l.verbose("Generate ACK reply for response",rs);
  var headers = {

    to: rs.headers.to,
    from: rs.headers.from,
    "call-id": rs.headers["call-id"],
    cseq: {method: "ACK", seq: rs.headers.cseq.seq}


  };





  var ack = makeRequest("ACK", rs.headers.contact[0].uri, headers, null, null);
  ack.headers["via"] = rs.headers.via;



  if(rs.headers["record-route"]) {
    ack.headers["route"] = [];
    for(var i=rs.headers["record-route"].length-1;i>=0;i--){
      l.debug("Push ack header",rs.headers["record-route"][i]);
      ack.headers["route"].push(rs.headers["record-route"][i]);

    }
  }

  l.verbose("Send ACK reply",JSON.stringify(ack,null,2));


  sip.send(ack);



  if(rs.headers["content-type"]=="application/sdp") {
    if(playing[rs.headers["call-id"]]) {
      l.debug("Already playing media for call " + rs.headers["call-id"]);
      return;
    }
    playing[rs.headers["call-id"]] = true;


    var sdp = transform.parse(rs.content);

    l.verbose("Got SDP in 200 answer",sdp);

    var packetSize = 172;//sdp.media[0].ptime*8;

    if(sdp.media[0].type=="audio") {
      l.debug("play RTP audio 0");
      var ip;
      if(sdp.media[0].connection) {
        ip = sdp.media[0].connection.ip;
      } else {
        ip =sdp.origin.address;
      }

      //exec('ffmpeg -re -f lavfi -i aevalsrc="sin(400*2*PI*t)" -ac 1 -b:a 64 -ar 8000  -acodec pcm_alaw -f rtp rtp://' + sdp.media[0].connection.ip  + ':' + sdp.media[0].port + '?pkt_size=258', (err, stdout, stderr) => {
      exec(ffmpeg.path + " -re  -i "+__basedir+"/caller.wav -filter_complex 'aresample=8000,asetnsamples=n="+packetSize+"' -ac 1 -vn  -acodec pcm_alaw -f rtp rtp://" + ip + ":" + sdp.media[0].port , (err, stdout, stderr) => {

        if (err) {
          l.error("Could not execute ffmpeg",err);
          return;
        }
        l.debug("Completed ffmpeg");

        // the *entire* stdout and stderr (buffered)
        l.debug("stdout:",stdout);
        l.debug("stderr:",stderr);
      });
      l.verbose("RTP audio playing");

    }

    if(sdp.media.length>1) {
      if(sdp.media[1].type=="audio") {
        l.verbose("play RTP audio 1");
        //sdp.media[1].ptime*8;
        //exec('ffmpeg -re -f lavfi -i aevalsrc="sin(400*2*PI*t)" -ac 1 -b:a 64 -ar 8000  -acodec pcm_alaw -f rtp rtp://' + sdp.media[0].connection.ip  + ':' + sdp.media[0].port + '?pkt_size=258', (err, stdout, stderr) => {
        exec(ffmpeg.path + " -re  -i "+__basedir+"/callee.wav -filter_complex 'aresample=8000,asetnsamples=n="+packetSize+"' -ac 1 -vn -acodec pcm_alaw -f rtp rtp://" + sdp.media[1].connection.ip  + ":" + sdp.media[1].port , (err, stdout, stderr) => {

          if (err) {
            l.error("Completed ffmpeg",err);
            return;
          }
          l.verbose("Running ffmpeg");

          // the *entire* stdout and stderr (buffered)
          l.debug("stdout:", stdout);
          l.debug("stderr:", stderr);
        });
        l.verbose("RTP audio playing");

      }

    }



  }






  var id = [rs.headers["call-id"], rs.headers.from.params.tag, rs.headers.to.params.tag].join(":");

  // registring our 'dialog' which is just function to process in-dialog requests
  if(!dialogs[id]) {
    dialogs[id] = function(rq) {
      if(rq.method === "BYE") {
        l.verbose("call received bye");

        delete dialogs[id];
        delete playing[rs["call-id"]];

        sip.send(sip.makeResponse(rq, 200, "Ok"));
      }
      else {
        sip.send(sip.makeResponse(rq, 405, "Method not allowed"));
      }
    };
  }

}

function replyToDigest(request,response,callback) {
  var session = {nonce: ""};
  var creds = {user:sipParams.userid,password:sipParams.password,realm:sipParams.domain, nonce:"",uri:""};

  digest.signRequest(session,request,response,creds);
  sip.send(request,function(rs) {
    l.debug("Received after sending authorized request: "+rs.status);
    if(rs.status==200){
      handle200(rs);
      gotFinalResponse(rs,callback);
    } else if (rs.status>200){
      gotFinalResponse(rs,callback);
    }
  }
  );
}

function gotFinalResponse(response,callback) {
  try {
    callback(response);
  } catch (e) {
    l.error("Error",e);
    process.exit(1);

  }
}


function makeRequest(method, destination, headers, contentType, body) {

  var req = {
    method: method,
    uri: destination,
    headers: {
      to: {uri: destination + ";transport="+sipParams.transport},
      from: {uri: "sip:"+sipParams.userid+"@"+sipParams.domain+"", params: {tag: rstring()}},
      "call-id": rstring(),
      cseq: {method: method, seq: Math.floor(Math.random() * 1e5)},
      contact: [{uri: "sip:"+sipParams.userid+"@" + sipParams.domain  + ";transport="+sipParams.transport  }],
      //    via: createVia(),
      "max-forwards" : 70

    }
  };

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
    "o=- 13374 13374 IN IP4 172.16.2.2\r\n"+
    "s=-\r\n"+
    "c=IN IP4 172.16.2.2\r\n"+
    "t=0 0\r\n"+
    "m=audio 16424 RTP/AVP 0 8 101\r\n"+
    "a=rtpmap:0 PCMU/8000\r\n"+
    "a=rtpmap:8 PCMA/8000\r\n"+
    "a=rtpmap:101 telephone-event/8000\r\n"+
    "a=fmtp:101 0-15\r\n"+
    "a=ptime:30\r\n"+
    "a=sendrecv\r\n";
    req.headers["content-type"] = "application/sdp";
  }

  for(var key in headers) {
    req[key] = headers[key];
  }

  return req;

}







var sipParams = {};



module.exports = function (chai, utils) {

  var  assert = chai.assert;


  utils.addMethod(chai.Assertion.prototype, "status", function (code) {

    var obj = utils.flag(this, "object");

    this.assert(
      obj.status == code
      , "expected SIP final response to have status code #{exp} but got #{act}"
      , "expected SIP final responseto not have status code #{act}"
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



  chai.sip = function (params){

    sipParams = params;
    sipParams.publicAddress = ip.address();
    sip.start(sipParams, function(rq) {
      //  console.log("Received request",rq);


      if(requestCallback) {

        try {
          if(rq.method=="INVITE") {
            rq.headers.to.params.tag = rstring();
          }
          requestCallback(rq);
        } catch (e) {
          l.error("Error",e);
          process.exit(1);

        }

        var resp = sip.makeResponse(rq, 200, "OK");
        resp.content =   "v=0\r\n"+
        "o=- 13374 13374 IN IP4 172.16.2.2\r\n"+
        "s=-\r\n"+
        "c=IN IP4 172.16.2.2\r\n"+
        "t=0 0\r\n"+
        "m=audio 16424 RTP/AVP 0 8 101\r\n"+
        "a=rtpmap:0 PCMU/8000\r\n"+
        "a=rtpmap:8 PCMA/8000\r\n"+
        "a=rtpmap:101 telephone-event/8000\r\n"+
        "a=fmtp:101 0-15\r\n"+
        "a=ptime:30\r\n"+
        "a=sendrecv\r\n";
        resp.headers["content-type"] = "application/sdp";
        resp.headers["contact"] = "<"+rq.uri+">";
        sip.send(resp);
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

    return {


      onFinalResponse : function(callback) {
        l.verbose("Sending");
        l.verbose(JSON.stringify(request,null,2),"\n\n");
        sip.send(request,
          function(rs) {

            l.verbose("Got response " + rs.status + " for callid "+ rs.headers["call-id"]);

            if(rs.status==401 || rs.status==407) {
              replyToDigest(request,rs,callback);
              l.verbose("Received auth response");
              l.verbose(JSON.stringify(rs,null,2));
              return;

            }
            if(rs.status >= 300) {
              l.verbose("call failed with status " + rs.status);
              gotFinalResponse(rs,callback);

              return;
            }
            else if(rs.status < 200) {
              l.verbose("call progress status " + rs.status + " " + rs.reason);
              return;
            }
            else {

              handle200(rs);
              gotFinalResponse(rs,callback);

            }
          });

      },
      invite : function(destination,headers,contentType,body) {


        body = fs.readFileSync(__basedir+ "/invitebody", "utf8");
        request = makeRequest("INVITE",destination,headers,"application/sdp",body);
        return this;
      },
      inviteSipRec : function(destination,headers,contentType,body) {
        if(!headers) {
          headers = {};
        }
        headers.contact = [{uri: "sip:"+sipParams.userid+"@" + sipParams.domain  + ";transport="+sipParams.transport,  params: {"+sip.src":""}}];
        headers.require = "siprec";
        headers.accept = "application/sdp, application/rs-metadata";
        if(!body) {



          body = fs.readFileSync(__basedir+"/siprecbody", "utf8");


        }
        request = makeRequest("INVITE",destination,headers,"multipart/mixed;boundary=foobar",body);
        return this;
      },
      message : function(destination,headers,contentType,body) {
        request = makeRequest("MESSAGE",destination,headers,contentType,body);
        return this;
      },
      waitForRequest : function(reqHandler) {
        requestCallback = reqHandler;
      },
      sendBye : function(req) {
        request = sendBye(req);
        return this;
      }
    };





  };




};
