var db = require('./db');
var utility = require('./utility');
var convert64to32 = utility.convert64to32;
var generateJob = utility.generateJob;
var async = require('async');
var r = require("./redis");
var jobs = r.jobs;
var updatePlayerCaches = require('./updatePlayerCaches');
var redis = r.client;

function insertMatch(match, cb) {
    async.series([function(cb) {
        //calling functions should explicitly set match.parse_status = 0 if they want the match to be queued for parse
        //this way full history doesn't overwrite existing parse_status (full history keeps it unset)
        updatePlayerCaches(match, {
            type: "api"
        }, cb);
        }], function decideParse(err) {
        if (err) {
            return cb(err);
        }
        else if (match.parse_status !== 0) {
            //not parsing this match
            //this isn't a error, although we want to report that we refused to parse back to user if it was a request
            return cb(err);
        }
        else {
            if (match.request) {
                //process requests with higher priority, one attempt only
                match.priority = "high";
                match.attempts = 1;
            }
            //queue it and finish
            return queueReq("parse", match, function(err, job2) {
                cb(err, job2);
            });
        }
    });
}

function insertMatchProgress(match, job, cb) {
    insertMatch(match, function(err, job2) {
        if (err) {
            return cb(err);
        }
        if (!job2) {
            //succeeded in API, but cant parse this replay
            job.progress(100, 100, "This replay is unavailable.");
            cb();
        }
        else {
            //wait for parse to finish
            job.progress(0, 100, "Parsing replay...");
            //request, parse and log the progress
            job2.on('progress', function(prog) {
                job.progress(prog, 100);
            });
            job2.on('failed', function(err) {
                cb(err);
            });
            job2.on('complete', function() {
                job.progress(100, 100, "Parse complete!");
                redis.setex("requested_match:" + match.match_id, 60 * 60 * 24, "1");
                cb();
            });
        }
    });
}

function insertPlayer(player, cb) {
    var account_id = Number(convert64to32(player.steamid));
    player.last_summaries_update = new Date();
    db.players.update({
        account_id: account_id
    }, {
        $set: player
    }, {
        upsert: true
    }, function(err) {
        cb(err);
    });
}

function queueReq(type, payload, cb) {
    var job = generateJob(type, payload);
    var kuejob = jobs.create(job.type, job).attempts(payload.attempts || 15).backoff({
        delay: 60 * 1000,
        type: 'exponential'
    }).removeOnComplete(true).priority(payload.priority || 'normal').save(function(err) {
        console.log("[KUE] created jobid: %s", kuejob.id);
        cb(err, kuejob);
    });
}
module.exports = {
    insertPlayer: insertPlayer,
    insertMatch: insertMatch,
    insertMatchProgress: insertMatchProgress,
    queueReq: queueReq
};