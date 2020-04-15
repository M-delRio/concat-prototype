const { spawn, spawnSync, execSync } = require("child_process");
const { readFileSync, writeFileSync, unlinkSync } = require("fs");
const AWS = require("aws-sdk");
const s3 = new AWS.S3();
const docClient = new AWS.DynamoDB.DocumentClient();
const transcodedChunksBucket = process.env.TRANSCODED_CHUNKS_BUCKET;
const endBucket = process.env.END_BUCKET;
const jobsTable = process.env.JOBS_TABLE;
const videosTable = process.env.VIDEOS_TABLE;
const manifestPath = `/tmp/manifest.ffcat`;

const getJobData = async (jobId) => {
  const dbQueryParams = {
    TableName: jobsTable,
    Key: { id: jobId },
  };

  console.log("Getting data from jobs table: ", JSON.stringify(dbQueryParams));

  return await docClient
    .get(dbQueryParams, function (err, data) {
      if (err) {
        console.error(
          "Unable to read item. Error JSON:",
          JSON.stringify(err, null, 2)
        );
      } else {
        console.log("Get from Jobs table succeeded: ", JSON.stringify(data));
        return data;
      }
    })
    .promise();
};

const writeJob = async (putParams) => {
  console.log(`Updating jobs table with params: ${JSON.stringify(putParams)}`);
  return await docClient
    .update(putParams, function (err, data) {
      if (err) {
        console.error(
          "Unable to update item. Error JSON:",
          JSON.stringify(err, null, 2)
        );
      } else {
        console.log(
          "Update to table succeeded:",
          JSON.stringify(data, null, 2)
        );
      }
    })
    .promise();
};

const recordJobCompleted = async ({ id: jobId, createdAt }) => {
  // update job status on DB to completed

  const jobEndTime = Date.now();
  const timeToCompleteSeconds = (jobEndTime - createdAt) / 1000;

  const putParams = {
    TableName: jobsTable,
    Key: { id: jobId },
    UpdateExpression:
      "set #s = :stat, completedAt = :completedAt, timeToComplete = :timeToComplete",
    ExpressionAttributeNames: {
      "#s": "status",
    },
    ExpressionAttributeValues: {
      ":stat": "completed",
      ":completedAt": jobEndTime,
      ":timeToComplete": timeToCompleteSeconds,
    },
    ReturnValues: `UPDATED_NEW`,
  };

  await writeJob(putParams);
};

const concatHttpToS3 = async (jobData) => {
  const { id: jobId, filename, outputType } = jobData;
  const manifestPath = `https://bento-transcoded-segments.s3.amazonaws.com/${jobId}/manifest.ffcat`;
  const videoKey = `${jobId}-${filename}${outputType}`;
  const s3Path = `s3://bento-video-end/${videoKey}`;

  console.log(`Attempting http concat with output to ${s3Path}`);

  const command = `/opt/ffmpeg/ffmpeg -f concat -safe 0 -protocol_whitelist file,https,tls,tcp -i ${manifestPath} -c copy -f mp4 -movflags frag_keyframe+empty_moov pipe:1 | /opt/awscli/aws s3 cp - ${s3Path}`;

  execSync(command, { stdio: "ignore" }, (err) => {
    if (err) {
      console.log(err);
      return false;
    } else {
      console.log("Sent to s3!");
    }
  });

  return true;
};

module.exports.simpleMerge = async (event) => {
  const simulateInvoke = event.simulateInvoke;
  const jobId = Number(event.jobId);
  let jobData = await getJobData(jobId);
  jobData = { ...jobData.Item };

  const { inputType, outputType, audioType, filename } = jobData;

  const videoPaths = {
    mergedPath: `/tmp/${filename}-Merged${outputType}`,
    originalPath: `/tmp/${filename}-Original${inputType}`,
    audioPath: `/tmp/${filename}-Audio${audioType}`,
    completedPath: `/tmp/${filename}-Completed${outputType}`,
  };

  concatHttpToS3(jobData);
  if (simulateInvoke) {
    console.log(`Simulation complete, exiting!`);
    return;
  }

  await recordJobCompleted(jobData);
};
