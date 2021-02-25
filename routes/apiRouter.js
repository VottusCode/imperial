const routes = require("express").Router();
const Datastore = require("nedb");
const fs = require("fs");
const Users = require("../models/Users");
const crypto = require("crypto");

const db = {
  link: new Datastore({ filename: "./databases/links" }),
};

// Possibly in the future make a config
// to easily edit mass used strings like this?
const internalError = (res) => {
  throwApiError(res, "Sorry! There was a internal server error, please contact a administrator!");
};

// Utilites
const throwApiError = require("../utilities/throwApiError");
const screenshotDocument = require("../utilities/screenshotDocument");
const generateString = require("../utilities/generateString");
const encrypt = require("../utilities/encrypt");
const decrypt = require("../utilities/decrypt");

routes.get("/", (req, res) => res.json({ message: "Welcome to Imperial Bin's API!" }));

routes.post(["/document", "/postCode", "/paste"], (req, res) => {
  db.link.loadDatabase();
  const code = req.body.code;
  // Anon function to quickly make a guest paste.
  const guestPaste = () => {
    createPaste(generateString(8), false, false, 5, "NONE", false);
  };

  if (!req.headers.authorization) return guestPaste();
  const apiToken = req.headers.authorization || req.body.apiToken;
  Users.findOne({ apiToken }, (err, user) => {
    if (err) return internalError(res);
    if (!user) return guestPaste();

    const creator = user._id.toString();
    // All settings related to the document,
    // should be a nice interface if we were using TS :)
    const documentSettings = {
      longerUrls: req.body.longerUrls || false,
      imageEmbed: req.body.imageEmbed || false,
      expiration: req.body.expiration || 5,
      instantDelete: req.body.instantDelete || false,
      quality: !user.memberPlus ? 73 : 100,
      encrypted: req.body.encrypted || false,
      password: req.body.password || false,
    };

    let str;
    if (documentSettings.longerUrls) str = generateString(26);
    else str = generateString(8);

    // The max duration is 31 days.
    if (documentSettings.expiration > 31) documentSettings.expiration = 31;

    return createPaste(
      str,
      documentSettings.imageEmbed,
      documentSettings.instantDelete,
      documentSettings.expiration,
      creator,
      documentSettings.quality,
      documentSettings.encrypted,
      documentSettings.password
    );
  });

  function createPaste(str, imageEmbed, instantDelete, expiration, creator, quality, encrypted, encryptedPassword) {
    const date = new Date();
    if (!code) return throwApiError(res, "You need to post code! No code was submitted.");
    let password, initVector, hashedPassword;

    if (encrypted) {
      password = typeof encryptedPassword === "string" ? encryptedPassword : generateString(12);
      initVector = crypto.randomBytes(16);
      hashedPassword = crypto.createHash("sha256").update(password).digest();
    }

    try {
      db.link.insert(
        {
          URL: str,
          imageEmbed,
          instantDelete,
          creator,
          code: encrypted ? encrypt(hashedPassword, code, initVector) : code,
          dateCreated: date.getTime(),
          deleteDate: date.setDate(date.getDate() + Number(expiration)),
          allowedEditor: [],
          encrypted,
          encryptedIv: encrypted ? initVector.toString("hex") : null,
        },
        async (err, doc) => {
          if (err) return internalError(res);
          // Make sure this is not a guest paste.
          if (creator !== "NONE") await Users.updateOne({ _id: creator }, { $inc: { documentsMade: 1 } });

          if (quality && !instantDelete && imageEmbed && !encrypted) screenshotDocument(str, quality);
          return res.json({
            success: true,
            documentId: str,
            rawLink: `https://www.imperialb.in/r/${str}`,
            formattedLink: `https://www.imperialb.in/p/${str}`,
            expiresIn: new Date(doc.deleteDate),
            instantDelete,
            encrypted,
            password: encrypted ? password : false,
          });
        }
      );
    } catch {
      return internalError(res);
    }
  }
});

routes.patch(["/document", "/editCode", "/paste"], (req, res) => {
  const apiToken = req.headers.authorization;
  if (!apiToken) return throwApiError(res, "An invalid API token was provided.");
  const document = req.body.document;
  const code = req.body.newCode || req.body.code;

  Users.findOne({ apiToken }, (err, user) => {
    if (err) return internalError(res);
    if (!user) return throwApiError(res, "Please put in an API token!");
    const userId = user._id.toString();

    db.link.loadDatabase();
    db.link.findOne({ URL: document }, async (err, documentInfo) => {
      if (err) return throwApiError(res, "Sorry! We couldn't find that document.");
      if (!documentInfo) return throwApiError(res, "Sorry! We couldn't find that document.");
      if (documentInfo.encrypted)
        return throwApiError(res, "Sorry! You can not edit encrypted documents just yet! Soon!");

      const editors = documentInfo.allowedEditor;
      // Make sure user is actually allowed to edit the document.
      if (documentInfo.creator != userId && editors.indexOf(userId) === -1)
        return throwApiError(res, "Sorry! You aren't allowed to edit this document.");

      db.link.update({ URL: document }, { $set: { code } }, (err) => {
        console.log(err);
        if (err) return throwApiError(res, "Sorry! You aren't allowed to edit this document.");

        return res.json({
          success: true,
          message: "Successfully edited the document!",
          documentId: document,
          rawLink: `https://www.imperialb.in/r/${document}`,
          formattedLink: `https://www.imperialb.in/p/${document}`,
          expiresIn: new Date(documentInfo.deleteDate),
          instantDelete: documentInfo.instantDelete,
        });
      });
    });
  });
});

routes.delete("/purgeDocuments", async (req, res) => {
  // If coming from outside
  let index = { apiToken: req.headers.authorization };
  // If coming from inside Imperial
  if (req.isAuthenticated()) {
    const authedUser = await Users.findOne({ _id: req.user.toString() });
    index = { _id: authedUser._id };
  }

  if (!index) return throwApiError(res, "Please put in an API token!");
  Users.findOne(index, (err, user) => {
    if (err) return internalError(res);
    if (!user) return throwApiError(res, "Please put in a valid API token!");
    const creator = user._id.toString();

    db.link.loadDatabase();
    db.link.find({ creator }, (err, documents) => {
      if (err) return internalError(res);
      if (documents.length == 0) return throwApiError(res, "There was no documents to delete!");
      // Go through every document to delete it.
      for (const document of documents) {
        const _id = document._id;
        db.link.remove({ _id });

        if (document.imageEmbed && fs.existsSync(`./public/assets/img/${document.URL}.jpg`))
          fs.unlinkSync(`./public/assets/img/${document.URL}.jpg`);
      }
      // (Tech) - I don't see a point in doing this again when
      // it's already loaded once above? Something i'm missing like
      // do the new values not update until you load this again?
      db.link.loadDatabase();
      // If the user is logged in redirect to the account page.
      if (Object.keys(index).indexOf("_id") > -1) return res.redirect("/account");
      return res.json({
        success: true,
        message: `Deleted a total of ${documents.length} documents!`,
        numberDeleted: documents.length,
      });
    });
  });
});

//                                             (Tech) - I hate cods.
routes.delete(["/document/:slug", "/deleteCode/:slug", "/deleteCod/:slug", "/paste/:slug"], async (req, res) => {
  let index = { apiToken: req.headers.authorization };
  if (req.isAuthenticated()) {
    const authedUser = await Users.findOne({ _id: req.user.toString() });
    index = { _id: authedUser._id };
  }

  if (!index) return throwApiError(res, "Please put in an API token!");
  const document = req.params.slug;

  Users.findOne(index, (err, user) => {
    if (err) return internalError(res);
    if (!user) return throwApiError(res, "Please put in a valid API token!");
    const userId = user._id.toString();

    db.link.loadDatabase();
    db.link.findOne({ URL: document }, (err, documentInfo) => {
      if (!documentInfo) return throwApiError(res, "Sorry! That document doesn't exist.");
      if (documentInfo.creator !== userId)
        return throwApiError(res, "Sorry! You aren't allowed to modify this document.");
      // Delete specific document.
      db.link.remove({ _id: documentInfo._id }, (err) => {
        if (err) return internalError(res);
        if (documentInfo.imageEmbed && fs.existsSync(`./public/assets/img/${documentInfo.URL}.jpg`))
          fs.unlinkSync(`./public/assets/img/${documentInfo.URL}.jpg`);
      });

      if (Object.keys(index).indexOf("_id") > -1) return res.redirect("/account");
      return res.json({
        success: true,
        message: "Successfully delete the document!",
      });
    });
  });
});

routes.get(["/document/:slug", "/getCode/:slug", "/paste/:slug"], (req, res) => {
  const document = req.params.slug;
  const password = req.query.password || false;
  db.link.loadDatabase();
  db.link.findOne({ URL: document }, (err, documentInfo) => {
    if (err) return internalError(res);
    if (!documentInfo) return throwApiError(res, "Sorry! There was no document with that ID.");
    if (documentInfo.encrypted && !password) {
      return throwApiError(
        res,
        "You need to pass ?password=PASSWORD with your request, since this paste is encrypted!",
        401
      );
    }

    let rawData;

    if (documentInfo.encrypted && password) {
      try {
        rawData = decrypt(password, documentInfo.code, documentInfo.encryptedIv);
      } catch {
        return throwApiError(res, "Incorrect password for encrypted document!", 401);
      }
    } else {
      rawData = documentInfo.code;
    }
    return res.json({
      success: true,
      document: rawData,
    });
  });
});

routes.get("/checkApiToken/:apiToken", (req, res) => {
  const apiToken = req.headers.authorization || req.params.apiToken;
  if (!apiToken) return throwApiError(res, "Please put in an API token!");

  Users.findOne({ apiToken }, (err, actuallyExists) => {
    if (err) return internalError(res);
    return res.json({
      success: actuallyExists ? true : false,
      message: actuallyExists ? "API token is valid!" : "API token is invalid!",
    });
  });
});

routes.get("/getShareXConfig/:apiToken", (req, res) => {
  const apiToken = req.headers.authorization || req.params.apiToken;
  res.attachment("imperialbin.sxcu").send({
    Version: "13.4.0",
    DestinationType: "TextUploader",
    RequestMethod: "POST",
    RequestURL: "https://imperialb.in/api/postCode/",
    Headers: {
      Authorization: apiToken,
    },
    Body: "JSON",
    Data: '{\n  "code": "$input$",\n  "longerUrls": false,\n  "imageEmbed": true,\n  "instantDelete": false\n}',
    URL: "$json:formattedLink$",
  });
});

routes.get("*", (req, res) => {
  throwApiError(res, "That route does not exist or you have inproper URL formatting!", 404);
});

module.exports = routes;
