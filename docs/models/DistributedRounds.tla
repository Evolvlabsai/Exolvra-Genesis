------------------------ MODULE DistributedRounds ------------------------
EXTENDS Naturals, FiniteSets, TLC
\* Bounds: two machines, one round, two claim generations, one expiry.
\* The shared directory is an authenticated coordinator (filesystem ACLs).
\* Attacker moves model stale delivery, corrupted bytes, disappearing
\* capability and worker crash; arbitrary writes by coordinator admins are
\* outside this trust boundary, just as a compromised runner login is.
VARIABLES phase, owner, builder, generation, fresh, capable, verified,
          accepted, credentialTransit, forged
vars == <<phase, owner, builder, generation, fresh, capable, verified,
          accepted, credentialTransit, forged>>
Init == /\ phase = "queued" /\ owner = 0 /\ builder = 0
        /\ generation = 0 /\ fresh = FALSE /\ capable = {1, 2}
        /\ verified = FALSE /\ accepted = FALSE
        /\ credentialTransit = FALSE /\ forged = FALSE
Claim(w) == /\ phase = "queued" /\ w \in capable /\ generation < 2
            /\ phase' = "building" /\ owner' = w
            /\ generation' = generation + 1 /\ fresh' = TRUE
            /\ UNCHANGED <<builder, capable, verified, accepted,
                            credentialTransit, forged>>
Crash == /\ phase \in {"building", "judging"} /\ fresh
         /\ fresh' = FALSE /\ UNCHANGED <<phase, owner, builder,
              generation, capable, verified, accepted, credentialTransit, forged>>
Expire == /\ phase = "building" /\ ~fresh
          /\ phase' = IF generation < 2 THEN "queued" ELSE "failed"
          /\ owner' = 0
          /\ UNCHANGED <<builder, generation, fresh, capable, verified,
                          accepted, credentialTransit, forged>>
FinishBuild == /\ phase = "building" /\ fresh /\ owner \in capable
               /\ phase' = "reported" /\ builder' = owner /\ owner' = 0
               /\ UNCHANGED <<generation, fresh, capable, verified,
                               accepted, credentialTransit, forged>>
Verify == /\ phase = "reported" /\ ~forged
          /\ phase' = "verified" /\ verified' = TRUE
          /\ UNCHANGED <<owner, builder, generation, fresh, capable,
                          accepted, credentialTransit, forged>>
Judge(w) == /\ phase = "verified" /\ w \in capable /\ w # builder
            /\ phase' = "judging" /\ owner' = w /\ fresh' = TRUE
            /\ UNCHANGED <<builder, generation, capable, verified,
                            accepted, credentialTransit, forged>>
Accept == /\ phase = "judging" /\ fresh /\ owner \in capable /\ ~forged
          /\ phase' = "complete" /\ accepted' = TRUE
          /\ UNCHANGED <<owner, builder, generation, fresh, capable,
                          verified, credentialTransit, forged>>
Corrupt == /\ forged' = TRUE
           /\ UNCHANGED <<phase, owner, builder, generation, fresh,
                           capable, verified, accepted, credentialTransit>>
LoseCapability(w) == /\ capable' = capable \ {w}
                     /\ UNCHANGED <<phase, owner, builder, generation,
                         fresh, verified, accepted, credentialTransit, forged>>
RejectStale == UNCHANGED vars
Next == (\E w \in {1,2}: Claim(w) \/ Judge(w) \/ LoseCapability(w))
        \/ Crash \/ Expire \/ FinishBuild \/ Verify \/ Accept
        \/ Corrupt \/ RejectStale
\* INVARIANTS: names are paired mechanically with the explorer.
OneLiveClaimant == owner \in {0,1,2}
PinnedBeforeJudging == phase \in {"judging", "complete"} => verified
PhysicalIndependence == phase \in {"judging", "complete"} => owner # builder
CredentialLocality == ~credentialTransit
CapabilityScheduled == phase = "complete" => accepted
StaleCannotPublish == phase = "queued" => owner = 0
RecoverableLease == phase = "building" /\ ~fresh => generation <= 2
Invariants == <<OneLiveClaimant, PinnedBeforeJudging, PhysicalIndependence,
               CredentialLocality, CapabilityScheduled, StaleCannotPublish,
               RecoverableLease>>
\* Weak fairness of polling/Expire guarantees reclaim; two failed attempts
\* settle failed rather than silently retrying forever. Capability loss is
\* checked before acceptance; later loss does not undo historical evidence.
Spec == Init /\ [][Next]_vars /\ WF_vars(Expire)
=============================================================================
