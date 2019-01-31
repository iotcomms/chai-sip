"use strict";

var expect = require("chai").expect;
var chai = require("chai");
var chaiSIP = require("chai-sip");


chai.use(chaiSIP);




var sip = chai.sip({userid:"<userid>",domain:"<sipdomain>", password:"<password>", transport:"TCP", port:5060});
//{route:"sip:127.0.0.1;transport=tcp"}
sip.inviteSipRec("sip:siprec@<sipdomain>;transport=tcp",null,null, null).onFinalResponse( (resp) =>  {
  expect(resp).to.be.status(200);
  setTimeout(()=> {
    sip.sendBye(resp);
  },5000);

});
