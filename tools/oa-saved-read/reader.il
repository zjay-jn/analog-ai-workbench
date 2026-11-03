; Fixed saved-copy reader. No master/CDF/term/bbox/geometry traversal or DB writes.
procedure(aawFail(message)
  fprintf(stderr "AAW_OA_READ_FAILED: %s\n" message)
  exit(2)
)
procedure(aawString(out value)
  unless(stringp(value) aawFail("expected stored string"))
  ; Strict Python JSON parsing rejects unsupported SKILL escapes.
  fprintf(out "%L" value)
)
procedure(aawNullable(out value)
  if(value then aawString(out value) else fprintf(out "null"))
)
procedure(aawWriteFacts(cv out captureId openedFilePath)
  let((instances nets ports iids tids owners nids pids ii ti ni pi first comma
       inst it net terminal prop value id)
    instances = dbGetq(cv instances)
    nets = dbGetq(cv nets)
    ports = dbGetq(cv terminals)
    when(length(instances)>2048 || length(nets)>4096 || length(ports)>1024
      aawFail("object limit"))
    iids = makeTable('aawIids nil)
    tids = makeTable('aawTids nil)
    owners = makeTable('aawOwners nil)
    nids = makeTable('aawNids nil)
    pids = makeTable('aawPids nil)
    ni = 0
    foreach(net nets
      nids[net] = sprintf(nil "net:%d" ni)
      ni = ni+1
    )
    ii = 0 ti = 0
    foreach(inst instances
      id = sprintf(nil "instance:%d" ii)
      iids[inst] = id
      let((localIndex)
        localIndex = 0
        foreach(it dbGetq(inst instTerms)
          when(tids[it] aawFail("multiple terminal owners"))
          tids[it] = sprintf(nil "terminal:%d:%d" ii localIndex)
          owners[it] = id
          localIndex = localIndex+1
          ti = ti+1
          when(ti>16384 aawFail("terminal limit"))
        )
      )
      ii = ii+1
    )
    pi = 0
    foreach(terminal ports
      pids[terminal] = sprintf(nil "port:%d" pi)
      pi = pi+1
    )
    fprintf(out "{\"schema\":\"aaw.oa-saved-read.reader.v1\",\"requestId\":")
    aawString(out captureId)
    fprintf(out ",\"provenance\":{\"openedFilePath\":")
    aawString(out openedFilePath)
    fprintf(out ",\"readMode\":\"fresh_process_read_only\"}")
    fprintf(out ",\"facts\":{\"instances\":[")
    first = t
    foreach(inst instances
      unless(first fprintf(out ",")) first = nil
      fprintf(out "{\"id\":") aawString(out iids[inst])
      fprintf(out ",\"name\":") aawString(out dbGetq(inst name))
      fprintf(out ",\"master\":{\"library\":") aawString(out dbGetq(inst libName))
      fprintf(out ",\"cell\":") aawString(out dbGetq(inst cellName))
      fprintf(out ",\"view\":") aawString(out dbGetq(inst viewName))
      fprintf(out "},\"parameters\":[")
      comma = nil
      when(length(dbGetq(inst prop))>256 aawFail("parameter limit"))
      foreach(prop dbGetq(inst prop)
        when(comma fprintf(out ",")) comma = t
        value = dbGetq(prop value)
        fprintf(out "{\"name\":") aawString(out dbGetq(prop name))
        fprintf(out ",\"valueType\":") aawString(out sprintf(nil "%L" type(value)))
        fprintf(out ",\"valueText\":") aawString(out sprintf(nil "%L" value))
        fprintf(out "}")
      )
      fprintf(out "],\"terminals\":[")
      comma = nil
      foreach(it dbGetq(inst instTerms)
        when(comma fprintf(out ",")) comma = t
        fprintf(out "{\"id\":") aawString(out tids[it])
        fprintf(out ",\"name\":null,\"role\":\"unknown\",\"netId\":")
        net = dbGetq(it net)
        when(net && !nids[net] aawFail("terminal net outside cellview"))
        aawNullable(out if(net nids[net] nil))
        fprintf(out "}")
      )
      fprintf(out "]}")
    )
    fprintf(out "],\"nets\":[")
    first = t
    foreach(net nets
      unless(first fprintf(out ",")) first = nil
      fprintf(out "{\"id\":") aawString(out nids[net])
      fprintf(out ",\"name\":") aawNullable(out dbGetq(net name))
      fprintf(out ",\"members\":[")
      comma = nil
      foreach(it dbGetq(net instTerms)
        unless(tids[it] && owners[it] aawFail("net member outside instances"))
        unless(dbGetq(it net)==net aawFail("reverse net mismatch"))
        when(comma fprintf(out ",")) comma = t
        fprintf(out "{\"kind\":\"instance_terminal\",\"instanceId\":")
        aawString(out owners[it])
        fprintf(out ",\"terminalId\":") aawString(out tids[it])
        fprintf(out "}")
      )
      foreach(terminal ports
        when(dbGetq(terminal net)==net
          when(comma fprintf(out ",")) comma = t
          fprintf(out "{\"kind\":\"port\",\"portId\":") aawString(out pids[terminal])
          fprintf(out "}")
        )
      )
      fprintf(out "]}")
    )
    fprintf(out "],\"ports\":[")
    first = t
    foreach(terminal ports
      unless(first fprintf(out ",")) first = nil
      fprintf(out "{\"id\":") aawString(out pids[terminal])
      fprintf(out ",\"name\":") aawNullable(out dbGetq(terminal name))
      fprintf(out ",\"direction\":") aawNullable(out dbGetq(terminal direction))
      fprintf(out ",\"netId\":")
      net = dbGetq(terminal net)
      when(net && !nids[net] aawFail("port net outside cellview"))
      aawNullable(out if(net nids[net] nil))
      fprintf(out "}")
    )
    fprintf(out "]}}")
  )
)
let((cv out captureId outputPath expectedFile ddFile openedFilePath)
  unless(getShellEnvVar("WSL_DISTRO_NAME")=="ROCKY9_LLM_LAB"
    aawFail("fixed environment required"))
  captureId = getShellEnvVar("AAW_OA_CAPTURE_ID")
  outputPath = getShellEnvVar("AAW_OA_RESULT_PATH")
  expectedFile = getShellEnvVar("AAW_OA_FILE_PATH")
  unless(captureId && outputPath && expectedFile aawFail("launcher context missing"))
  ddFile = ddGetObj("FOLDED_CASCODE" "FOLDED_CASCODE" "schematic" "sch.oa")
  unless(ddFile aawFail("copied schematic file is unavailable"))
  openedFilePath = ddFile~>readPath
  unless(openedFilePath && openedFilePath==expectedFile
    aawFail("resolved schematic file does not match capture copy"))
  cv = dbOpenCellViewByType("FOLDED_CASCODE" "FOLDED_CASCODE" "schematic" "" "r")
  unless(cv aawFail("read-only copied schematic open failed"))
  unless(dbGetq(cv libName)=="FOLDED_CASCODE" &&
         dbGetq(cv cellName)=="FOLDED_CASCODE" &&
         dbGetq(cv viewName)=="schematic"
    aawFail("opened cellview identity differs"))
  out = outfile(outputPath "w")
  unless(out aawFail("result open failed"))
  aawWriteFacts(cv out captureId openedFilePath)
  close(out)
  dbClose(cv)
  exit(0)
)
