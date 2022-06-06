// Copyright 2018-2022 the Deno authors. All rights reserved. MIT license.

import { Datastore } from "google_datastore";

import { keys } from "./auth.ts";

export const datastore = new Datastore(keys);
