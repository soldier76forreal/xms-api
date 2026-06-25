
const sharp = require("sharp");
const path = require("path");
const fs = require("fs");
const mongoose = require("mongoose");

// Get DB connection (already connected inside xmsPr)
const dbConnection = mongoose.createConnection('mongodb://localhost:27017/xms', {
    useNewUrlParser: true,
    useUnifiedTopology: true,
    useFindAndModify: false 
});
;

// Import schema
const fileSchema = require("./models/fileModel");

// Create model from schema
const File = dbConnection.model("file", fileSchema);

async function generateThumbnails() {
    console.log("Has find:", typeof File.find); // should be 'function'

    const files = await File.find({
        $or: [
            { thumbnail: { $exists: false } },
            { thumbnail: null },
            { thumbnail: "" }
        ],
        "metaData.mimetype": /^image\//
    });

    console.log("Found:", files.length);

    for (const doc of files) {
        try {
            if (!doc.metaData?.path) continue;
            if (!fs.existsSync(doc.metaData.path)) continue;

            const uploadDir =
                doc.metaData.destination || path.dirname(doc.metaData.path);

            const thumbName = `thumb-${doc.metaData.filename}`;
            const thumbPath = path.join(uploadDir, thumbName);

            // Skip if thumbnail already exists on disk
            if (fs.existsSync(thumbPath)) {
                doc.thumbnail = thumbName;
                await doc.save();
                continue;
            }

            await sharp(doc.metaData.path)
                .resize(300)
                .jpeg({ quality: 80 })
                .toFile(thumbPath);

            doc.thumbnail = thumbName;
            await doc.save();

            console.log("Created:", thumbName);
        } catch (err) {
            console.error("Failed for:", doc._id, err.message);
        }
    }

    console.log("All thumbnails generated");
    process.exit(0);
}

generateThumbnails();
