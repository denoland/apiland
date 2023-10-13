import { entityToObject, objectSetKey, objectToEntity } from "google_datastore";
import { getDatastore } from "./auth.ts";
import { kinds, kv } from "./consts.ts";
import { Build, OwnerQuota } from "./types.d.ts";
import {
  type TarEntry,
  Untar,
} from "https://deno.land/std@0.204.0/archive/untar.ts";
import { readerFromStreamReader } from "https://deno.land/std@0.204.0/streams/reader_from_stream_reader.ts";
import { readAll } from "https://deno.land/std@0.204.0/streams/read_all.ts";
import { pooledMap } from "https://deno.land/std@0.204.0/async/pool.ts";
import {
  getMeta,
  uploadMetaJson,
  uploadVersionMetaJson,
  uploadVersionRaw,
} from "./webhook.ts";

const DEFAULT_MAX_TOTAL_SIZE = 1024 * 1024 * 20; // 20 mb in total

export async function publish(buildID: string) {
  const datastore = await getDatastore();
  const res = await datastore.lookup(
    datastore.key([kinds.BUILD_KIND, buildID]),
  );
  let build: Build;
  if (res.found && res.found.length === 1) {
    build = entityToObject<Build>(res.found[0].entity);
  } else {
    throw new Error("Build does not exist!");
  }

  switch (build.upload_options.type) {
    case "github":
      try {
        await publishGithub(build);
      } catch (err) {
        console.log("error", err, err?.response, build);

        await saveBuild({
          ...build,
          status: "error",
          message: err.message,
        });
        return;
      }
      break;
    default:
      throw new Error(`Unknown build type: ${build.upload_options.type}`);
  }

  await kv.enqueue({
    kind: "load",
    module: build.module,
    version: build.version,
  });

  await saveBuild({
    ...build,
    status: "success",
    message: "Published module.",
  });
}

async function publishGithub(build: Build) {
  console.log(
    `Publishing ${build.module} at ${build.upload_options.ref} from GitHub`,
  );

  const datastore = await getDatastore();

  await saveBuild({
    ...build,
    status: "publishing",
  });

  let { module, version, upload_options: { repository, ref, subdir } } = build;

  if (subdir) {
    subdir = subdir.replace(/(^\/|\/$)/g, "") + "/";
  }

  const tarballRes = await fetch(
    `https://api.github.com/repos/${repository}/tarball/${ref}`,
  );
  const readableStreamReader = tarballRes.body
    .pipeThrough(new DecompressionStream("gzip")).getReader();
  const untarStream = ReadableStream.from<TarEntry>(
    new Untar(readerFromStreamReader(readableStreamReader)),
  );

  let totalSize = 0;
  const entries = [];

  for await (const entry of untarStream) {
    // remove tarball filename
    entry.fileName = entry.fileName.slice(entry.fileName.indexOf("/") + 1);

    if (subdir) {
      if (entry.fileName.startsWith(subdir) && entry.fileName !== subdir) {
        entry.fileName = entry.fileName.slice(subdir.length);

        totalSize += entry.fileSize;
        entries.push(entry);
      }
    } else {
      totalSize += entry.fileSize;
      entries.push(entry);
    }
  }

  const res = await datastore.lookup(
    datastore.key([
      kinds.LEGACY_OWNER_QUOTAS,
      build.upload_options.repository.split("/")[0] as string,
    ]),
  );
  let quota: OwnerQuota | undefined;
  if (res.found && res.found.length === 1) {
    quota = entityToObject<OwnerQuota>(res.found[0].entity);
  }

  if (totalSize > (quota?.max_total_size ?? DEFAULT_MAX_TOTAL_SIZE)) {
    const message =
      `Module too large (${totalSize} bytes). Maximum allowed size is ${DEFAULT_MAX_TOTAL_SIZE} bytes.`;
    console.log(message);
    throw new Error(message);
  }

  const pool = pooledMap(65, entries, async (entry) => {
    if (entry.type === "file") {
      const body = await readAll(entry);
      await uploadVersionRaw(
        module,
        version,
        entry.path,
        body,
      );
      entry.close();
    }
  });

  for await (const _ of pool) {
    //
  }


  const versions = await getMeta(module);
  await uploadMetaJson(
    module,
    { latest: version, versions: [version, ...(versions?.versions || [])] },
  );

  // Upload directory listing to S3
  await uploadVersionMetaJson(
    module,
    version,
    {
      directory_listing: entries.sort((a, b) =>
        a.fileName.localeCompare(b.fileName, "en-US")
      ),
      uploaded_at: new Date().toISOString(),
      upload_options: {
        type: "github",
        repository,
        subdir,
        ref,
      },
    },
  );
}

async function saveBuild(build: Build) {
  const datastore = await getDatastore();

  objectSetKey(build, datastore.key([kinds.BUILD_KIND, build.id]));

  for await (
    const _ of datastore.commit([{ upsert: objectToEntity(build) }], {
      transactional: false,
    })
  ) {
    // empty
  }
}
