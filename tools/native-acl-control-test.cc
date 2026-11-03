#include "agent-work-cycle-runner-native-security.h"

// Exercise the production control-bit comparison in memory only. This program
// never opens a file, changes an ACL, creates a profile or starts another process.
int main(){
  using C=SECURITY_DESCRIPTOR_CONTROL;
  constexpr C base=SE_SELF_RELATIVE|SE_DACL_PRESENT,ai=SE_DACL_AUTO_INHERITED,p=SE_DACL_PROTECTED,req=SE_DACL_AUTO_INHERIT_REQ;
  struct Case {const char* name;C prior;C current;bool directory;bool expected;};
  const Case cases[]={
    {"unchanged_directory",base,base,true,true},
    {"unchanged_directory_auto_inherited",base|ai,base|ai,true,true},
    {"unchanged_protected_directory",base|p,base|p,true,true},
    {"unchanged_protected_directory_auto_inherited",base|p|ai,base|p|ai,true,true},
    {"unchanged_file",base,base,false,true},
    {"unchanged_file_auto_inherited",base|ai,base|ai,false,true},
    {"unchanged_protected_file",base|p,base|p,false,true},
    {"unchanged_protected_file_auto_inherited",base|p|ai,base|p|ai,false,true},
    {"unprotected_directory_forward_normalization",base,base|ai,true,true},
    {"file_forward_change",base,base|ai,false,false},
    {"directory_reverse_change",base|ai,base,true,false},
    {"file_reverse_change",base|ai,base,false,false},
    {"protected_directory_forward_change",base|p,base|p|ai,true,false},
    {"protected_file_forward_change",base|p,base|p|ai,false,false},
    {"protection_set",base,base|p,true,false},
    {"protection_cleared",base|p,base,true,false},
    {"forward_with_protection_set",base,base|p|ai,true,false},
    {"reverse_with_protection_cleared",base|p|ai,base,true,false},
    {"forward_with_dacl_present_change",base,SE_SELF_RELATIVE|ai,true,false},
    {"forward_with_self_relative_change",base,SE_DACL_PRESENT|ai,true,false},
    {"forward_with_auto_inherit_request_change",base,base|ai|req,true,false},
    {"legacy_unchanged_compared_bits_directory",base,base|req,true,true},
    {"legacy_unchanged_compared_bits_file",base,base|req,false,true},
    {"reverse_with_auto_inherit_request_change",base|ai,base|req,true,false},
  };
  size_t failed=0;std::string names;
  for(const auto& item:cases)if(aaw::RestoredDaclControlEquivalent(item.prior,item.current,item.directory)!=item.expected){++failed;if(!names.empty())names+=',';names+='"';names+=item.name;names+='"';}
  std::cout<<"{\"schema\":\"aaw.native-acl-control-test/v1\",\"status\":\""<<(failed?"FAIL":"PASS")<<"\",\"cases\":"<<std::size(cases)<<",\"failed\":"<<failed<<",\"failures\":["<<names<<"]}"<<std::endl;
  return failed?1:0;
}
